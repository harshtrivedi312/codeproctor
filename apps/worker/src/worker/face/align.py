"""5-point alignment to the 112x112 crop AuraFace expects (ADR 0001 section 12.2).

A similarity transform (scale, rotation, translation; no shear) is estimated with the Umeyama
method from the detected landmarks to the standard ArcFace template, then the image is warped by
bilinear sampling. Pure numpy, so alignment is testable without OpenCV or MediaPipe.
"""

from __future__ import annotations

from typing import Final

import numpy as np
import numpy.typing as npt

from worker.face.types import ALIGNED_SIZE, AlignedFace, Image, Landmarks5

# Standard ArcFace 112x112 template: left eye, right eye, nose tip, left mouth, right mouth.
ARCFACE_TEMPLATE: Final[Landmarks5] = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)

Matrix = npt.NDArray[np.float64]


def estimate_similarity(src: Landmarks5, dst: Landmarks5) -> Matrix:
    """2x3 matrix M with dst ~ M @ [x, y, 1], least squares over similarity transforms."""
    if src.shape != (5, 2) or dst.shape != (5, 2):
        raise ValueError("Expected 5 landmarks of shape (5, 2).")
    s = src.astype(np.float64)
    d = dst.astype(np.float64)
    s_mean, d_mean = s.mean(axis=0), d.mean(axis=0)
    s_c, d_c = s - s_mean, d - d_mean
    var = float((s_c**2).sum() / len(s))
    if var < 1e-9:
        raise ValueError("Degenerate landmarks.")
    cov = d_c.T @ s_c / len(s)
    u, sing, vt = np.linalg.svd(cov)
    sign = np.eye(2)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        sign[1, 1] = -1
    rot = u @ sign @ vt
    scale = float((sing * np.diag(sign)).sum() / var)
    trans = d_mean - scale * rot @ s_mean
    return np.hstack([scale * rot, trans.reshape(2, 1)])


def warp_to_template(image: Image, matrix: Matrix, size: int = ALIGNED_SIZE) -> Image:
    """Warp `image` (H, W, 3) with the forward matrix into a size x size crop (bilinear)."""
    full = np.vstack([matrix, [0.0, 0.0, 1.0]])
    inv = np.linalg.inv(full)
    ys, xs = np.mgrid[0:size, 0:size]
    coords = np.stack([xs.ravel(), ys.ravel(), np.ones(size * size)])
    sx, sy = (inv @ coords)[:2]
    h, w = image.shape[:2]
    x0, y0 = np.floor(sx).astype(np.int64), np.floor(sy).astype(np.int64)
    fx, fy = (sx - x0)[:, None], (sy - y0)[:, None]

    def px(yy: npt.NDArray[np.int64], xx: npt.NDArray[np.int64]) -> npt.NDArray[np.float64]:
        inside = (xx >= 0) & (xx < w) & (yy >= 0) & (yy < h)
        out = np.zeros((len(xx), 3), dtype=np.float64)
        out[inside] = image[yy[inside], xx[inside]]
        return out

    top = px(y0, x0) * (1 - fx) + px(y0, x0 + 1) * fx
    bottom = px(y0 + 1, x0) * (1 - fx) + px(y0 + 1, x0 + 1) * fx
    out = top * (1 - fy) + bottom * fy
    result: Image = np.clip(np.rint(out), 0, 255).astype(np.uint8).reshape(size, size, 3)
    return result


def align_face(image: Image, landmarks: Landmarks5) -> AlignedFace:
    return AlignedFace(warp_to_template(image, estimate_similarity(landmarks, ARCFACE_TEMPLATE)))
