# Artwork and 3D assets

## skeleton.glb — the posable 3D skeleton

Cut from the **[Z-Anatomy](https://github.com/LluisV/Z-Anatomy)** skeletal
atlas by `scripts/extract-skeleton.mjs`.

> Models from the Z-Anatomy project, by Lluís Vinent Juanico and contributors.
> Licensed **[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)**.

**Share-alike applies.** `skeleton.glb` is a derivative of a CC BY-SA 4.0 work,
so it carries the same licence and the attribution above has to travel with it.
That covers this asset, not the rest of the source in this repository.

### Regenerating it

The source FBX is ~41 MB and is not committed. Fetch it and re-run the
extractor with the dev server running:

```sh
GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 https://github.com/LluisV/Z-Anatomy /tmp/z-anatomy
mkdir -p vendor/fbx
cp "/tmp/z-anatomy/Z-Anatomy PC/Assets/Models/1.0 Models/SkeletalSystem100.fbx" vendor/fbx/skeleton.fbx
npm start &
node scripts/extract-skeleton.mjs
```

The atlas holds 1,952 separately named structures — bones and soft tissue
together, ~4.9M vertices, in a standing rest pose at life size. The extractor
drops the soft tissue, merges what remains into the twenty-odd pieces the rig
actually moves, welds duplicate vertices (which alone takes ~1.97M vertices
down to ~315K), and records where each piece's two joints sit in the rest pose.
Those joint pairs are what let `js/mirror/skeleton3d.js` pose a bone: map the
rest pair onto the live landmark pair with a rotation, a uniform scale and a
translation.

## source-skeleton.png — the 2D anatomical plate

An anterior view supplied by the project owner, believed to be the labelled
diagram distributed via Wikimedia Commons as public domain. **Confirm that
before relying on it** — this repository is public.

`bones/` holds sprites cut from it by `scripts/slice-bones.mjs`. **These are
not currently drawn**: the skeleton is real 3D geometry now, not flat artwork.
They are kept only as a possible source of surface texture for the 3D meshes.
