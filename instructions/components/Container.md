COMPONENT: Container

An invisible box. It draws nothing itself: it arranges the components inside it in rows, columns or a grid.

Written as `<Container> ... </Container>` with other components between the tags.

| Attribute | Values | What it does on screen |
|---|---|---|
| layout | block, flex, flex-column, grid | How the components inside are arranged. block: one under another, each as wide as the box (the default). flex: side by side in one row. flex-column: stacked top to bottom. grid: equal-width columns, as many as `columns` says. |
| columns | a number from 1 to 6 | The number of equal columns when layout is grid. With 3, the fourth component starts a second row. |
| gap | none, xs, sm, md, lg, xl, from no space to the widest | The space between the components inside. none makes them touch. The default is sm. |
| padding | none, xs, sm, md, lg, xl, from no space to the widest | The space between the edge of the box and what is inside it. The default is none. |
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
| hoverable | no value | The box is highlighted while the mouse is over it. |

```component
<Container layout="grid" columns="3" gap="md">
  <Card><Typography weight="bold">One</Typography></Card>
  <Card><Typography weight="bold">Two</Typography></Card>
  <Card><Typography weight="bold">Three</Typography></Card>
</Container>
```
That draws three panels side by side in equal columns with a medium space between them.
