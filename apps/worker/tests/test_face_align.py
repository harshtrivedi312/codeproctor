from __future__ import annotations

import numpy as np
import pytest

from worker.face.align import ARCFACE_TEMPLATE, align_face, estimate_similarity, warp_to_template


def transform(points: np.ndarray, scale: float, deg: float, tx: float, ty: float) -> np.ndarray:
    a = np.deg2rad(deg)
    rot = np.array([[np.cos(a), -np.sin(a)], [np.sin(a), np.cos(a)]])
    out: np.ndarray = (scale * points @ rot.T + [tx, ty]).astype(np.float32)
    return out


@pytest.mark.parametrize(
    ("scale", "deg", "tx", "ty"),
    [
        (1.0, 0.0, 0.0, 0.0),
        (2.0, 0.0, 30.0, 40.0),
        (1.7, 20.0, 100.0, 80.0),
        (0.5, -35.0, 5.0, 9.0),
    ],
)
def test_fr403_alignment_recovers_known_similarity_transform(
    scale: float, deg: float, tx: float, ty: float
) -> None:
    src = transform(
        ARCFACE_TEMPLATE, scale, deg, tx, ty
    )  # where the face landmarks sit in the photo
    m = estimate_similarity(src, ARCFACE_TEMPLATE)
    mapped = src @ m[:, :2].T + m[:, 2]
    assert np.allclose(mapped, ARCFACE_TEMPLATE, atol=1e-3)
    # similarity only: the 2x2 part is scale * rotation (no shear), so its columns are orthogonal
    assert abs(float(m[:, 0] @ m[:, 1])) < 1e-6
    assert np.isclose(np.linalg.norm(m[:, 0]), np.linalg.norm(m[:, 1]))


def test_fr403_alignment_is_robust_to_small_landmark_noise() -> None:
    rng = np.random.default_rng(1)
    src = transform(ARCFACE_TEMPLATE, 2.0, 10.0, 50.0, 60.0)
    noisy = src + rng.normal(0, 0.5, src.shape).astype(np.float32)
    m = estimate_similarity(noisy, ARCFACE_TEMPLATE)
    mapped = src @ m[:, :2].T + m[:, 2]
    assert np.abs(mapped - ARCFACE_TEMPLATE).max() < 2.0


def test_fr403_warp_places_marker_squares_at_template_positions() -> None:
    """Draw 5 coloured markers at transformed landmarks; the 112x112 crop must show them at the template."""
    scale, deg, tx, ty = 2.0, 15.0, 60.0, 40.0
    src = transform(ARCFACE_TEMPLATE, scale, deg, tx, ty)
    image = np.full((300, 300, 3), 255, dtype=np.uint8)
    colours = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (255, 255, 0), (255, 0, 255)]
    for (x, y), c in zip(src, colours, strict=True):
        image[int(y) - 4 : int(y) + 5, int(x) - 4 : int(x) + 5] = c
    crop = align_face(image, src).pixels
    assert crop.shape == (112, 112, 3) and crop.dtype == np.uint8
    for (x, y), c in zip(ARCFACE_TEMPLATE, colours, strict=True):
        assert np.array_equal(crop[int(round(y)), int(round(x))], c)


def test_fr403_identity_transform_returns_the_same_112_crop() -> None:
    rng = np.random.default_rng(2)
    image = rng.integers(0, 256, (112, 112, 3), dtype=np.uint8)
    m = np.array([[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    assert np.array_equal(warp_to_template(image, m), image)


def test_fr403_warp_outside_the_photo_is_black_not_an_error() -> None:
    image = np.full((50, 50, 3), 200, dtype=np.uint8)
    m = np.array([[1.0, 0.0, 500.0], [0.0, 1.0, 500.0]])
    assert int(warp_to_template(image, m).max()) == 0


def test_fr403_estimate_rejects_bad_shape_and_degenerate_landmarks() -> None:
    with pytest.raises(ValueError):
        estimate_similarity(np.zeros((4, 2), dtype=np.float32), ARCFACE_TEMPLATE)
    with pytest.raises(ValueError):
        estimate_similarity(np.ones((5, 2), dtype=np.float32), ARCFACE_TEMPLATE)


def test_fr403_mirrored_landmarks_do_not_produce_a_reflection() -> None:
    mirrored = ARCFACE_TEMPLATE.copy()
    mirrored[:, 0] = 112 - mirrored[:, 0]
    m = estimate_similarity(mirrored, ARCFACE_TEMPLATE)
    assert np.linalg.det(m[:, :2]) > 0
