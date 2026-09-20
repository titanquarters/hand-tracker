# Bone artwork

`source-skeleton.png` is an anterior view of the human skeleton, supplied by the
project owner. It appears to be the labelled anatomical diagram distributed via
Wikimedia Commons, which is published there as public domain. **Confirm that
licensing before relying on it** — this repository is public, and the file is
redistributed with it.

`bones/` holds the individual bone sprites cut from that plate by
`scripts/slice-bones.mjs`, plus a `manifest.json` describing each one. They are
generated, not hand-edited: change the slice table in that script and re-run it
rather than editing the PNGs.

**These are not currently drawn.** The skeleton is real 3D geometry now
(`js/mirror/skeleton3d.js`), not flat artwork posed on the picture. The sprites
are kept because the next step for realism is to use them as textures on those
meshes, which needs the same slices.

```sh
node scripts/slice-bones.mjs
```

Each sprite is extracted already rotated, so its bone runs along the sprite's
+x axis starting `pad` pixels in and centred vertically. That matches the local
frame the drawn bones use, so posing one onto tracked landmarks is a translate,
a rotate and a uniform scale — and the same sprite can be handed straight to the
physics engine when the skeleton collapses.

The slicer also cleans the plate on the way out: the white background is keyed
to transparent, the blue and red leader lines are inpainted from neighbouring
bone pixels rather than left as holes, the label text is removed (except on the
skull and neck, where the nasal aperture and eye sockets are genuinely black),
and the crop border is feathered so neighbouring anatomy caught inside a crop
fades out instead of ending in a hard rectangular edge.
