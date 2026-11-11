"""Local virtual try-on for the worker: CatVTON on this machine's GPU (Apple MPS) or CPU.

Started and fed by lib/ai/providers/tryon-local.ts. Loads the model once, then answers one request per line:

  stdin   {"id": "...", "person": "<png>", "mask": "<png>", "garment": "<png>", "out": "<png>",
           "steps": 20, "width": 384, "height": 512, "seed": 42,
           "sampler": "unipc" | "ddim" (optional, default "ddim"),
           "guided": 0.6 (optional, default 1: the share of the steps that compare with and without the garment)}
  stdout  {"ready": true}                       once, after loading
          {"id": "...", "ok": true, "ms": 81234}
          {"id": "...", "ok": false, "error": "OUT_OF_MEMORY" | "INVALID_REQUEST" | "FAILED"}

The person picture and mask are already cropped to width:height; the garment is padded with white.
Only safetensors are loaded (never pickles), from the folder `pnpm tryon:setup` fills and checks.
Nothing is logged except these lines; images and paths never reach stderr.

The method (garment and person side by side in one inpainting UNet, cross-attention skipped, fine-tuned
self-attention) is CatVTON's (Chong et al., 2024). The try-on weights are CC BY-NC-SA 4.0: non-commercial.
"""

import json
import math
import os
import sys
import time

import numpy as np
import torch
from diffusers import AutoencoderKL, DDIMScheduler, UNet2DConditionModel, UniPCMultistepScheduler
from diffusers.models.attention_processor import SlicedAttnProcessor
from PIL import Image
from safetensors.torch import load_file

WEIGHTS = sys.argv[1]
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
DTYPE = torch.float16 if DEVICE == "mps" else torch.float32
GUIDANCE = 2.5
ATTENTION_WEIGHTS = "CatVTON/dresscode-16k-512/attention/model.safetensors"  # trained at 512x384, the size we run at


class SkipCrossAttention:
    """There's no text: cross-attention passes its input straight through (as the weights were trained)."""

    def __call__(self, attn, hidden_states, encoder_hidden_states=None, attention_mask=None, temb=None, *args, **kwargs):
        return hidden_states


def load():
    unet = UNet2DConditionModel.from_pretrained(
        os.path.join(WEIGHTS, "stable-diffusion-inpainting"), subfolder="unet", variant="fp16", torch_dtype=DTYPE, use_safetensors=True
    )
    # Self-attention one head at a time: person + garment is a long sequence, and the full score
    # matrix wouldn't fit next to the weights on an 8 GB Mac.
    unet.set_attn_processor({name: (SlicedAttnProcessor(1) if name.endswith("attn1.processor") else SkipCrossAttention()) for name in unet.attn_processors})
    attn1 = [module for name, module in unet.named_modules() if name.endswith("attn1")]
    for block in attn1:
        # Half-precision scores overflow on these sequences: score and softmax in float32.
        block.upcast_attention = True
        block.upcast_softmax = True
    # The try-on weights replace every self-attention layer; they're stored by position (8 apart).
    state = load_file(os.path.join(WEIGHTS, ATTENTION_WEIGHTS))
    for key, tensor in state.items():
        index, rest = key.split(".", 1)
        if int(index) % 8 != 0:
            raise ValueError("unexpected attention weights")
        target = attn1[int(index) // 8].get_parameter(rest)
        if target.shape != tensor.shape:
            raise ValueError("unexpected attention weights")
        with torch.no_grad():
            target.copy_(tensor.to(DTYPE))
    if len(state) != 80:
        raise ValueError("unexpected attention weights")
    unet = unet.to(DEVICE).eval()
    # The image encoder/decoder runs on the CPU: on the GPU it needs over 1 GB of scratch memory.
    vae = AutoencoderKL.from_pretrained(os.path.join(WEIGHTS, "sd-vae-ft-mse"), torch_dtype=torch.float32, use_safetensors=True).eval()
    scheduler = DDIMScheduler.from_pretrained(os.path.join(WEIGHTS, "stable-diffusion-inpainting"), subfolder="scheduler")
    return unet, vae, scheduler


def picture(path, size, mode):
    image = Image.open(path)
    image.load()
    return image.convert(mode).resize(size, Image.LANCZOS)


@torch.no_grad()
def try_on(unet, vae, scheduler, request):
    size = (request["width"], request["height"])
    person = picture(request["person"], size, "RGB")
    mask = picture(request["mask"], size, "L")
    garment = picture(request["garment"], size, "RGB")

    def pixels(image):
        return torch.from_numpy(np.asarray(image, dtype=np.float32) / 127.5 - 1).permute(2, 0, 1)[None]

    def encode(x):
        return (vae.encode(x).latent_dist.sample(generator=generator) * vae.config.scaling_factor).to(DEVICE)

    generator = torch.Generator("cpu").manual_seed(request["seed"])
    keep = torch.from_numpy((np.asarray(mask, dtype=np.float32) >= 128).astype(np.float32))[None, None]
    masked = encode(pixels(person) * (keep < 0.5))
    cond = encode(pixels(garment))
    mask_latent = torch.nn.functional.interpolate(keep.to(DEVICE), size=masked.shape[-2:], mode="nearest")
    # The person (to repaint) and the garment, stacked into one tall picture.
    inputs = [
        torch.cat([mask_latent, torch.zeros_like(mask_latent)], dim=-2),
        torch.cat([masked, torch.zeros_like(cond)], dim=-2),  # without the garment (guidance)
        torch.cat([masked, cond], dim=-2),
    ]
    latents = torch.randn(inputs[2].shape, generator=generator).to(DEVICE)
    # UniPC (a multistep solver) gets in 20 steps where DDIM needs 30 or more. It keeps the last steps'
    # results, so each try-on gets its own.
    unipc = request.get("sampler") == "unipc"
    sampler = UniPCMultistepScheduler.from_config(scheduler.config) if unipc else scheduler
    # UniPC solves a small linear system each step, which Apple's GPU can't: its steps run on the CPU
    # (the latents are tiny; only the UNet needs the GPU).
    sampler.set_timesteps(request["steps"], device="cpu" if unipc else DEVICE)
    latents = latents * sampler.init_noise_sigma
    # Guidance (comparing a pass without the garment) settles what is drawn in the early steps; the last
    # ones only sharpen it, so they can skip the second pass.
    guided = math.ceil(len(sampler.timesteps) * request.get("guided", 1))

    def predict(x, t, cond_input):
        return unet(torch.cat([x, inputs[0], cond_input], dim=1).to(DTYPE), t, encoder_hidden_states=None, return_dict=False)[0].float()

    for index, t in enumerate(sampler.timesteps):
        if DEVICE == "mps":
            torch.mps.empty_cache()
        x = sampler.scale_model_input(latents, t)
        with_garment = predict(x, t, inputs[2])
        if index < guided:
            # One pass at a time, with then without the garment: half the memory of a batch of two.
            without = predict(x, t, inputs[1])
            noise = without + GUIDANCE * (with_garment - without)
        else:
            noise = with_garment
        if unipc:
            latents = sampler.step(noise.cpu(), t, latents.cpu()).prev_sample.to(DEVICE)
        else:
            latents = sampler.step(noise, t, latents, eta=1.0, generator=generator).prev_sample
    if not torch.isfinite(latents).all():
        raise FloatingPointError("non-finite result")
    latents = latents.split(latents.shape[-2] // 2, dim=-2)[0]
    image = vae.decode((latents / vae.config.scaling_factor).float().cpu()).sample
    image = ((image[0].clamp(-1, 1) + 1) * 127.5).permute(1, 2, 0).round().byte().numpy()
    Image.fromarray(image).save(request["out"], format="PNG")


def valid(request):
    if not isinstance(request, dict) or not isinstance(request.get("id"), str):
        return False
    for key in ("person", "mask", "garment", "out"):
        if not isinstance(request.get(key), str) or not os.path.isabs(request[key]):
            return False
    for key, low, high in (("steps", 1, 100), ("width", 128, 1024), ("height", 128, 1366), ("seed", 0, 2**31 - 1)):
        if not isinstance(request.get(key), int) or not low <= request[key] <= high:
            return False
    if request.get("sampler", "ddim") not in ("ddim", "unipc"):
        return False
    guided = request.get("guided", 1)
    if isinstance(guided, bool) or not isinstance(guided, (int, float)) or not 0 < guided <= 1:
        return False
    return request["width"] % 8 == 0 and request["height"] % 8 == 0


def reply(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    unet, vae, scheduler = load()
    reply({"ready": True, "device": DEVICE})
    for line in sys.stdin:
        try:
            request = json.loads(line)
        except ValueError:
            request = None
        if not valid(request):
            reply({"id": request.get("id") if isinstance(request, dict) and isinstance(request.get("id"), str) else None, "ok": False, "error": "INVALID_REQUEST"})
            continue
        start = time.time()
        try:
            try_on(unet, vae, scheduler, request)
            reply({"id": request["id"], "ok": True, "ms": round((time.time() - start) * 1000)})
        except RuntimeError as error:
            reply({"id": request["id"], "ok": False, "error": "OUT_OF_MEMORY" if "out of memory" in str(error) else "FAILED"})
        except Exception:
            reply({"id": request["id"], "ok": False, "error": "FAILED"})


if __name__ == "__main__":
    main()
