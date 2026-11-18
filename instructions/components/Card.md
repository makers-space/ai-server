COMPONENT: Card

A box drawn as a rounded panel with a thin border. Like a Container it arranges the components inside it, and it is also visible itself.

Written as `<Card> ... </Card>` with other components between the tags.

| Attribute | Values | What it does on screen |
|---|---|---|
| bordered | true, false | true draws the thin border around the panel (the default). false removes it, leaving only the fill. |
| borderColor | primary, secondary, tertiary | The colour of the border. |
| borderStrength | normal, soft | normal is a clear line. soft is a fainter one. |
| radius | sm, md, lg, xl | How rounded the corners are, from slightly to very. |
| shadow | true, false | true adds a soft shadow under the panel so it looks raised. The default is false. |
| hover | true, false | true makes the panel lift slightly while the mouse is over it. The default is false. |
| layout | block, flex, flex-column, grid | How the components inside are arranged. block: one under another, each as wide as the box (the default). flex: side by side in one row. flex-column: stacked top to bottom. grid: equal-width columns, as many as `columns` says. |
| columns | a number from 1 to 6 | The number of equal columns when layout is grid. With 3, the fourth component starts a second row. |
| gap | none, xs, sm, md, lg, xl, from no space to the widest | The space between the components inside. none makes them touch. The default is sm. |
| padding | none, xs, sm, md, lg, xl, from no space to the widest | The space between the edge of the box and what is inside it. The default is md. |
| justify | start, center, end, between, around, evenly | Where the contents sit along the layout direction (across a flex row, down a flex-column). start, center and end push them together at that place. between puts the first at one edge and the last at the other with equal space between. around puts equal space on both sides of each. evenly makes every space equal, the edges included. |
| align | start, center, end, stretch, baseline | Where the contents sit across the layout direction (up and down in a flex row). stretch makes each one fill the box in that direction. baseline lines up their text. |
| wrap | true, false | Whether a flex row may continue on a new line when it runs out of width. false keeps everything on one line. |
| flexFill | no value | Makes this box take the space left over when it sits inside a flex box, so its neighbours keep only the width they need. |
| width, height | a CSS length such as 100% or 240px | The size of the box. |
| minWidth, minHeight, maxWidth | a CSS length such as 100% or 240px | The smallest or largest the box may become. |
| backgroundColor | surface, background, primary, secondary, tertiary | Fills the box with a colour of the theme. surface is the colour of panels, background the colour of the page, the other three the theme's own colours. |
| background | grid, graph, dots, lines, diagonal, crosshatch, checker, hex, plus, waves, zigzag, rings, aurora, gradient | Draws a faint pattern behind the contents. grid: square grid lines. graph: graph paper, a fine grid with a heavier line every fifth cell. dots: a grid of dots. lines: horizontal ruled lines. diagonal: diagonal stripes. crosshatch: diagonal stripes both ways. checker: a checkerboard. hex: a honeycomb. plus: small plus signs. waves: wavy lines. zigzag: zigzag lines. rings: rings spreading from the centre. aurora: soft blobs of colour that drift slowly. gradient: a wash of colour that moves slowly across. |
| backgroundIntensity | subtle, medium, strong | How visible the pattern is, from barely there to clearly drawn. |
| backgroundSize | sm, md, lg | The size of the pattern's cells. |
| backgroundMotion | drift, pulse | Animates the pattern. drift slides it slowly. pulse fades it in and out. |
| backgroundTone | primary, secondary, tertiary, neutral | The colour the pattern is drawn in. neutral is grey. |
| backgroundFade | radial, top, bottom, left, right, center | Where the pattern fades away. radial: strongest in the middle, gone at the edges. top, bottom, left, right: it fades out toward that side. center: it shows at the left and right edges and is clear in the middle. |

```component
<Card layout="flex-column" gap="sm" padding="md">
  <Container layout="flex" justify="between" align="center">
    <Typography weight="bold">Server status</Typography>
    <Badge color="success">Online</Badge>
  </Container>
  <ProgressBar value="72" label="Disk used" showPercentage />
</Card>
```
That draws a rounded panel: a bold title on the left with a green pill on the right, and a bar filled to 72% under them.
