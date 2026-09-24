# Mark generator

`python3 gen4.py out.svg f2.json` draws the mark: `outline` is the foot and leg (closed Catmull-Rom),
`sole` is the thin cut above the sole, `straps` are the mask cuts (the A, the ankle strap, the toe strap),
`feathers` are `[x, y, angle, length, width, bend]`. The published `../mark.svg` is this output with the
viewBox set to `12.2 -5.4 84 84` (centred). `sheet.html#out.svg` previews it at four sizes on three grounds.
