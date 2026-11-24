"""Stand-in for rembg, which TripoSR imports but we never use: the worker sends the garment already cut out."""


def new_session(*args, **kwargs):
    raise RuntimeError("background removal isn't used: the garment arrives cut out")


def remove(*args, **kwargs):
    raise RuntimeError("background removal isn't used: the garment arrives cut out")
