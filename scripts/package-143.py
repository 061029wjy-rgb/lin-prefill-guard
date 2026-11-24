"""Create an installable zip from the exact, clean release commit. No upload or network.
Usage: python3 scripts/package-143.py /path/to/output
Full Git history back to the pinned public baseline is required for the included source bundle.
"""
import datetime, hashlib, json, pathlib, shutil, subprocess, sys, tempfile, zipfile
from pathlib import Path, PurePosixPath

repo = Path(__file__).resolve().parents[1]
def git(*args):
    return subprocess.check_output(['git', '-C', str(repo), *args])
def sha(data):
    return hashlib.sha256(data).hexdigest()
if len(sys.argv) != 2:
    raise SystemExit('Usage: python3 scripts/package-143.py OUTPUT_DIRECTORY')
out = Path(sys.argv[1]).resolve()
if out.is_relative_to(repo):
    raise SystemExit('Use an output directory outside the source tree')
out.mkdir(parents=True, exist_ok=True)
assert not git('status','--porcelain').strip(), 'release requires a clean tree'
head = git('rev-parse','HEAD').decode().strip()
parent = git('rev-parse','HEAD^').decode().strip()
assert parent == '7aed2c68a2f633a571dc79c765f27ca374c00828', 'unexpected predecessor'
public = '475c555bca1831c402554b1262c762ce85911096'
files = [s.decode() for s in git('ls-tree','-r','--name-only','-z','HEAD').split(bytes(1)) if s]
m = {f:git('show','HEAD:'+f) for f in files}
for f in files:
    zpath=PurePosixPath(f)
    assert not zpath.is_absolute() and '..' not in zpath.parts
    assert not set(zpath.parts) & {'.git','node_modules','upload','__pycache__'}
assert not {'BUILD.json','SHA256SUMS.txt'} & m.keys()
assert json.loads(m['manifest.json'])['version'] == json.loads(m['package.json'])['version'] == '1.4.3'
with tempfile.TemporaryDirectory() as td:
    bundle=Path(td)/'source-1.4.3.bundle'
    git('bundle','create',str(bundle),'HEAD','^'+public)
    git('bundle','verify',str(bundle))
    content=bundle.read_bytes()
m['provenance/source-1.4.3.bundle']=content
info={'extension':'Lin 预填充助手','version':'1.4.3','build':'LPG-1.4.3.1','releaseDate':'2026-11-24','sourceCommit':head,
      'gitTree':git('rev-parse','HEAD^{tree}').decode().strip(),'baseVersion':'1.4.2','baseCommit':parent,
      'baseZipSha256':'a60b5ada76202e315772b7a18a040ade66f74f2b4de0fc1160a1596c8633880a','publicBaseline':public,
      'sourceBundle':{'file':'provenance/source-1.4.3.bundle','requiresCommit':public,'sha256':sha(content)},
      'validation':'docs/VALIDATION-1.4.3.md'}
m['BUILD.json']=(json.dumps(info,ensure_ascii=False,indent=2)+chr(10)).encode()
m['SHA256SUMS.txt']=''.join(sha(data)+'  '+name+chr(10) for name,data in sorted(m.items())).encode()
stamp=datetime.datetime.fromtimestamp(int(git('show','-s','--format=%ct','HEAD')),datetime.timezone.utc).timetuple()[:6]
prefix='lin-prefill-guard/'
target=out/'lin-prefill-guard-1.4.3.zip'
with zipfile.ZipFile(target,'w') as z:
    for name,data in sorted(m.items()):
        i=zipfile.ZipInfo(prefix+name,date_time=stamp);i.create_system=3;i.external_attr=(0o100644<<16)
        z.writestr(i,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
with zipfile.ZipFile(target) as z:
    assert z.testzip() is None and set(z.namelist()) == set(prefix+name for name in m)
    lines=z.read(prefix+'SHA256SUMS.txt').decode().splitlines()
    assert len(lines)==len(m)-1
    for line in lines:
        h,f=line.split('  ',1);assert sha(z.read(prefix+f))==h,f
    for f in ['manifest.json','index.js','shield-engine.js','docs/images/v143/panel-375.png','evidence/v143/real-143.json']:
        assert z.getinfo(prefix+f).file_size>0,f
shutil.copyfile(repo/'docs/images/v143/guard-modes.png',out/'Lin-1.4.3-mobile.png')
print(f'{target.name}: {target.stat().st_size} bytes; {len(m)} members; SHA256 {sha(target.read_bytes())}; source {head}')
