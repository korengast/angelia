import sys,json
from gen import feather
from gen3 import catmull
P=json.load(open(sys.argv[2]))
o=P['outline']
foot="M%.2f %.2f "%tuple(o[0])+catmull([tuple(p) for p in o])+" Z"
sole=P['sole']; sole="M%.2f %.2f "%tuple(sole[0])+catmull([tuple(p) for p in sole])
fs="".join(f'<path d="{feather(*f)}"/>' for f in P['feathers'])
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{P['vb']}" fill="currentColor">
<defs><mask id="am" maskUnits="userSpaceOnUse" x="-50" y="-50" width="250" height="250"><rect x="-50" y="-50" width="250" height="250" fill="#fff"/>
<g stroke="#000" fill="none" stroke-linejoin="miter">{P['straps']}<path stroke-width="{P['gap']}" d="{sole}"/></g></mask></defs>
<path mask="url(#am)" d="{foot}"/>{fs}</svg>'''
open(sys.argv[1],'w').write(svg)
