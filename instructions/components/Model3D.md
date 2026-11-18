COMPONENT: Model3D

A 3D viewer. The user can turn the shape with the mouse and zoom in and out. The shape comes from a file, or you write it yourself as text.

Written as `<Model3D src="https://..." />` for a file (glb, gltf, obj, stl, fbx, ply, dae, 3mf, vox, 3ds), or as `<Model3D format="obj"> text </Model3D>` with the text of an OBJ or ASCII STL file between the tags.

| Attribute | Values | What it does on screen |
|---|---|---|
| src | the https address of a 3D model file | The file that is shown. |
| format | obj, stl | For your own text: which of the two formats it is written in. |
| fileName | a file name such as pyramid.obj | The name the shape is shown under. |
| autoRotate | no value | The shape turns slowly by itself. |
| height | a CSS length such as 100% or 240px | How tall the viewer is. The default is 360px. |

Your own shape in OBJ: one statement on each line. Every corner is "v x y z". Every face is "f" followed by the numbers of its corners, counted from 1. Use all three of x, y and z so the shape has depth.

```component
<Model3D format="obj" fileName="pyramid.obj" autoRotate>
v 0 0 0
v 1 0 0
v 1 0 1
v 0 0 1
v 0.5 1 0.5
f 1 2 3 4
f 1 2 5
f 2 3 5
f 3 4 5
f 4 1 5
</Model3D>
```
