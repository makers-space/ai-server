COMPONENT: Image

A picture. It comes from an address, or you draw it yourself as SVG.

Written as `<Image src="https://..." alt="..." />` for a picture file (png, jpg, gif, webp, svg), or as `<Image> SVG markup </Image>` with your own `<svg>...</svg>` between the tags.

| Attribute | Values | What it does on screen |
|---|---|---|
| src | the https address of a picture file | The picture that is shown. |
| alt | text | A description of the picture, read out by screen readers and shown if the picture cannot load. |
| width, height | a CSS length such as 100% or 240px | The size it is shown at. Without them it is shown at its own size, never wider than the reply. |

```component
<Image alt="A red circle" width="120px">
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="crimson" /></svg>
</Image>
```
