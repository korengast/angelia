import math,sys
def feather(px,py,ang,L,W,bend):
    # axis from pivot along angle (deg, y-up), tip bent by `bend` degrees
    a=math.radians(ang); b=math.radians(ang+bend)
    dx,dy=math.cos(a),-math.sin(a)
    tx=px+dx*L*0.55+math.cos(b)*L*0.45; ty=py+dy*L*0.55-math.sin(b)*L*0.45
    mx,my=px+dx*L*0.5,py+dy*L*0.5
    nx,ny=-dy,dx
    c1=(mx+nx*W,my+ny*W); c2=(mx-nx*W*0.8,my-ny*W*0.8)
    return f"M{px:.1f} {py:.1f} Q{c1[0]:.1f} {c1[1]:.1f} {tx:.1f} {ty:.1f} Q{c2[0]:.1f} {c2[1]:.1f} {px:.1f} {py:.1f}Z"
def mark(feathers, extra=""):
    fs="".join(f'<path d="{feather(*f)}"/>' for f in feathers)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="currentColor">
<defs><mask id="k"><rect width="100" height="100" fill="#fff"/>
<g stroke="#000" stroke-linecap="butt" fill="none">
<path stroke-width="2.2" d="M28 9 L60 21 M28 21 L60 9 M30 21 L60 33 M30 33 L60 21"/>
<path stroke-width="2.2" d="M34 45 L62 37"/>
<path stroke-width="2.2" d="M81 62 L71 81"/>
<path stroke-width="1.7" d="M38 49 C42 56 48 59 55 61.5 L84 77.5 C89 80 94 79.5 99 76"/>
</g></mask></defs>
<path mask="url(#k)" d="M34 4 C33 14 36 26 40 36 C42 42 40 48 42 52 C44 57 49 60 55 63 L84 80 C90 83 95 83 94.5 79 C93 76 88 72 82 68 C70 60 60 52 55 42 C52 34 51 18 52 4 Z"/>
{fs}{extra}</svg>'''
open(sys.argv[1],'w').write(mark([(41,44,152,40,7,-14),(41,46,170,33,6,-14),(41,48,188,25,5,-12)]))
