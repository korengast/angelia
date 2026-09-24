import math,sys,json
from gen import feather
def norm(v):
    l=math.hypot(*v); return (v[0]/l,v[1]/l)
def catmull(pts,closed=False):
    # Catmull-Rom through pts -> cubic bezier path segments (no M)
    out=[];n=len(pts)
    for i in range(n-1):
        p0=pts[i-1] if i>0 else pts[i]; p1=pts[i]; p2=pts[i+1]; p3=pts[i+2] if i+2<n else pts[i+1]
        c1=(p1[0]+(p2[0]-p0[0])/6,p1[1]+(p2[1]-p0[1])/6); c2=(p2[0]-(p3[0]-p1[0])/6,p2[1]-(p3[1]-p1[1])/6)
        out.append(f"C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}")
    return " ".join(out)
def resample(spine,widths,k=6):
    pts=[];ws=[]
    for i in range(len(spine)-1):
        for t in range(k):
            u=t/k;pts.append((spine[i][0]*(1-u)+spine[i+1][0]*u,spine[i][1]*(1-u)+spine[i+1][1]*u));ws.append(widths[i]*(1-u)+widths[i+1]*u)
    pts.append(spine[-1]);ws.append(widths[-1]);return pts,ws
def smooth_spine(spine,k=8):
    # sample catmull through spine
    out=[];n=len(spine)
    for i in range(n-1):
        p0=spine[i-1] if i>0 else spine[i]; p1=spine[i]; p2=spine[i+1]; p3=spine[i+2] if i+2<n else spine[i+1]
        for t in range(k):
            u=t/k;u2=u*u;u3=u2*u
            out.append(tuple(0.5*((2*p1[j])+(-p0[j]+p2[j])*u+(2*p0[j]-5*p1[j]+4*p2[j]-p3[j])*u2+(-p0[j]+3*p1[j]-3*p2[j]+p3[j])*u3) for j in (0,1)))
    out.append(spine[-1]);return out
def sides(spine,widths,k=8):
    sp=smooth_spine(spine,k)
    # widths interpolated per original segment
    ws=[]
    for i in range(len(spine)-1):
        for t in range(k): u=t/k; ws.append(widths[i]*(1-u)+widths[i+1]*u)
    ws.append(widths[-1])
    L=[];R=[]
    for i,p in enumerate(sp):
        a=sp[max(i-1,0)];b=sp[min(i+1,len(sp)-1)];d=norm((b[0]-a[0],b[1]-a[1]));nrm=(-d[1],d[0])
        L.append((p[0]+nrm[0]*ws[i]/2,p[1]+nrm[1]*ws[i]/2));R.append((p[0]-nrm[0]*ws[i]/2,p[1]-nrm[1]*ws[i]/2))
    return sp,ws,L,R
def taper(spine,widths):
    sp,ws,L,R=sides(spine,widths)
    end=sp[-1];r=ws[-1]/2
    d=f"M{L[0][0]:.2f} {L[0][1]:.2f} "+catmull(L)+f" A{r:.2f} {r:.2f} 0 0 0 {R[-1][0]:.2f} {R[-1][1]:.2f} "+catmull(R[::-1])+" Z"
    return d
def offset_line(spine,widths,inset,side='R'):
    sp,ws,L,R=sides(spine,[w-2*inset for w in widths])
    pts=R if side=='R' else L
    return "M%.2f %.2f "%pts[0]+catmull(pts)
def _main():
    P=json.load(open(sys.argv[2]))
    spine=P['spine'];w=P['w']
    foot=taper(spine,w)
    hx,hy,hr=P['heel']
    fs="".join(f'<path d="{feather(*f)}"/>' for f in P['feathers'])
    g=P.get('gap',1.5); ins=P.get('inset',2.8)
    sole_old=offset_line(spine[P.get('sole_from',2):]+[[spine[-1][0]+(spine[-1][0]-spine[-2][0]),spine[-1][1]+(spine[-1][1]-spine[-2][1])]],w[P.get('sole_from',2):]+[w[-1]],ins,P.get('side','R'))
    sp_,ws_,L_,R_=sides(spine,[x-2*ins for x in w])
    k=8; start=P.get('sole_from',3)*k
    arc=[(hx+(hr-ins)*math.cos(math.radians(a)),hy+(hr-ins)*math.sin(math.radians(a))) for a in range(P.get('arc0',200),P.get('arc1',95),-15)]
    pts=arc+L_[start:]
    last=pts[-1];prev=pts[-3];pts.append((last[0]+(last[0]-prev[0])*2,last[1]+(last[1]-prev[1])*2))
    sole="M%.2f %.2f "%pts[0]+catmull(pts)
    svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{P['vb']}" fill="currentColor">
    <defs><mask id="k" maskUnits="userSpaceOnUse" x="-50" y="-50" width="250" height="250"><rect x="-50" y="-50" width="250" height="250" fill="#fff"/>
    <g stroke="#000" fill="none">{P['straps']}{P.get('cut','')}
    <path stroke-width="{g}" d="{sole}"/>
    
    </g></mask></defs>
    <g mask="url(#k)"><path d="{foot}"/><circle cx="{hx}" cy="{hy}" r="{hr}"/></g>{fs}</svg>'''
    open(sys.argv[1],'w').write(svg)
if __name__=="__main__": _main()
