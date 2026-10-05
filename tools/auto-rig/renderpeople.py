"""
RenderPeople rigged FBX -> GLB for tools/auto-rig, run in Blender:

  blender -b --python tools/auto-rig/renderpeople.py -- <in.fbx> <out.glb> [texture px]

Renames the RenderPeople joints that X Bot also has to Mixamo's names, so auto-rig keeps the
model's own skin weights (twist, face and finger-end joints hand their weights to the nearest
matched joint), and scales the 8K textures down (default 1024 px).
"""
import os
import sys

import bpy

args = sys.argv[sys.argv.index('--') + 1:]
src, out = args[0], args[1]
size = int(args[2]) if len(args) > 2 else 1024

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src)

RENAME = {'hip': 'Hips', 'spine_01': 'Spine', 'spine_02': 'Spine1', 'spine_03': 'Spine2',
          'neck': 'Neck', 'head': 'Head'}
for side, Side in (('l', 'Left'), ('r', 'Right')):
    RENAME.update({f'shoulder_{side}': f'{Side}Shoulder', f'upperarm_{side}': f'{Side}Arm',
                   f'lowerarm_{side}': f'{Side}ForeArm', f'hand_{side}': f'{Side}Hand',
                   f'upperleg_{side}': f'{Side}UpLeg', f'lowerleg_{side}': f'{Side}Leg',
                   f'foot_{side}': f'{Side}Foot', f'ball_{side}': f'{Side}ToeBase'})
    for finger, Finger in (('thumb', 'Thumb'), ('index', 'Index'), ('middle', 'Middle'),
                           ('ring', 'Ring'), ('pinky', 'Pinky')):
        for k in (1, 2, 3):
            RENAME[f'{finger}_0{k}_{side}'] = f'{Side}Hand{Finger}{k}'

renamed = 0
for o in bpy.data.objects:
    if o.type == 'ARMATURE':
        for b in o.data.bones:
            if b.name in RENAME:
                b.name = RENAME[b.name]
                renamed += 1
print(f'renamed {renamed} joints')

for image in bpy.data.images:
    if image.size[0] > size:
        image.scale(size, size)

bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_animations=False,
                          export_image_format='JPEG', export_jpeg_quality=85)
print(f'wrote {out}: {os.path.getsize(out) / 1e6:.2f} MB')
