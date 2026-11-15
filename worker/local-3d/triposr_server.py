"""The 3D view's model for the worker: TripoSR on this machine's GPU (Apple MPS) or CPU.

Started and fed by lib/ai/providers/model3d-local.ts. Loads the model once, then answers one request per line:

  stdin   {"id": "...", "picture": "<png>", "out": "<glb>", "resolution": 192}
  stdout  {"ready": true}                       once, after loading
          {"id": "...", "ok": true, "ms": 9234}
          {"id": "...", "ok": false, "error": "OUT_OF_MEMORY" | "INVALID_REQUEST" | "FAILED"}

The picture is the garment alone on a transparent backdrop (RGBA PNG). The answer is a mesh coloured per
vertex, Y up, as a GLB. Only safetensors are loaded (never pickles), from the folder `pnpm model3d:setup`
fills and checks; TripoSR's code comes from the commit the setup pinned. Nothing is logged except these
lines; images and paths never reach stderr.

The method (a transformer predicting a triplane NeRF from one picture, then marching cubes) is TripoSR's
(Tochilkin et al., 2024; MIT). On an 8 GB Mac the transformer runs in half precision with attention one
head at a time, and the mesh is made on the CPU with a CPU copy of the small colour/density decoder.
"""

import copy
import json
import os
import sys
import time

WEIGHTS = sys.argv[1]
SOURCE = sys.argv[2]
sys.path[:0] = [os.path.join(os.path.dirname(os.path.abspath(__file__)), "shim"), SOURCE]

import numpy as np  # noqa: E402
import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402
import trimesh  # noqa: E402
from omegaconf import OmegaConf  # noqa: E402
from PIL import Image  # noqa: E402
from safetensors.torch import load_file  # noqa: E402

DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
_attention = F.scaled_dot_product_attention


def _sliced_attention(q, k, v, *args, **kwargs):
    """One attention head at a time: the full table for all heads doesn't fit beside the weights on 8 GB."""
    if q.dim() != 4 or q.device.type != "mps":
        return _attention(q, k, v, *args, **kwargs)
    return torch.cat([_attention(q[:, h : h + 1], k[:, h : h + 1], v[:, h : h + 1], *args, **kwargs) for h in range(q.shape[1])], dim=1)


F.scaled_dot_product_attention = _sliced_attention

import tsr.models.tokenizers.image as image_tokenizer  # noqa: E402

# The image encoder's description is read from the checked file, never downloaded.
image_tokenizer.hf_hub_download = lambda repo_id, filename, **_: os.path.join(WEIGHTS, "dino-vitb16", filename)

from tsr.system import TSR  # noqa: E402
from tsr.utils import resize_foreground  # noqa: E402


def load():
    config = OmegaConf.load(os.path.join(WEIGHTS, "TripoSR", "config.yaml"))
    OmegaConf.resolve(config)
    model = TSR(config)
    model.load_state_dict(load_file(os.path.join(WEIGHTS, "TripoSR", "model.safetensors")))
    model.renderer.set_chunk_size(2048)
    model.eval()
    cpu_decoder = copy.deepcopy(model.decoder).float()
    model.to(DEVICE)
    if DEVICE == "mps":
        model.half()
    return model, cpu_decoder


def build(model, cpu_decoder, request):
    image = Image.open(request["picture"])
    image.load()
    if image.width * image.height > 4096 * 4096:
        raise ValueError("picture too large")
    image = resize_foreground(image.convert("RGBA"), 0.85)
    pixels = np.array(image).astype(np.float32) / 255.0
    # On a mid-grey backdrop, as the model was trained.
    pixels = pixels[:, :, :3] * pixels[:, :, 3:4] + (1 - pixels[:, :, 3:4]) * 0.5
    image = Image.fromarray((pixels * 255.0).astype(np.uint8))
    half = DEVICE == "mps"
    with torch.no_grad(), torch.autocast(device_type=DEVICE, dtype=torch.float16, enabled=half):
        codes = model([image], device=DEVICE)
    codes = codes.float().cpu()
    if DEVICE == "mps":
        torch.mps.empty_cache()
    on_device = model.decoder
    model.decoder = cpu_decoder
    try:
        with torch.no_grad():
            mesh = model.extract_mesh(codes, True, resolution=request["resolution"])[0]
    finally:
        model.decoder = on_device
    if len(mesh.vertices) == 0:
        raise FloatingPointError("empty mesh")
    # TripoSR's axes to glTF's: Y up, and the front (the picture's side) facing +Z, towards a viewer's
    # first look. Its own demo turns the other way and opens on the back.
    mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))
    mesh.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [0, 1, 0]))
    mesh.export(request["out"], file_type="glb")


def valid(request):
    if not isinstance(request, dict) or not isinstance(request.get("id"), str):
        return False
    for key in ("picture", "out"):
        if not isinstance(request.get(key), str) or not os.path.isabs(request[key]):
            return False
    resolution = request.get("resolution")
    return isinstance(resolution, int) and not isinstance(resolution, bool) and 64 <= resolution <= 320


def reply(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    model, cpu_decoder = load()
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
            build(model, cpu_decoder, request)
            reply({"id": request["id"], "ok": True, "ms": round((time.time() - start) * 1000)})
        except (OSError, ValueError):
            reply({"id": request["id"], "ok": False, "error": "INVALID_REQUEST"})
        except RuntimeError as error:
            reply({"id": request["id"], "ok": False, "error": "OUT_OF_MEMORY" if "out of memory" in str(error) else "FAILED"})
        except Exception:
            reply({"id": request["id"], "ok": False, "error": "FAILED"})
        finally:
            if DEVICE == "mps":
                torch.mps.empty_cache()


if __name__ == "__main__":
    main()
