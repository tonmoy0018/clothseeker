"""Stand-in for torchmcubes (which needs a C++ build): the same marching_cubes, done by PyMCubes on the CPU."""

import mcubes
import numpy as np
import torch


def marching_cubes(volume, threshold):
    verts, faces = mcubes.marching_cubes(volume.detach().cpu().numpy().astype(np.float64), threshold)
    # torchmcubes gives vertices as (x, y, z) with x along the volume's last axis.
    verts = torch.from_numpy(verts[:, [2, 1, 0]].astype(np.float32))
    return verts, torch.from_numpy(faces.astype(np.int64))
