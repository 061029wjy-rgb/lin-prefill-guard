import {readFileSync,readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {VERSION} from '../core.js';
const files=(d,re)=>readdirSync(d,{withFileTypes:true}).filter(x=>x.isFile()&&re.test(x.name)).map(x=>d==='.'?x.name:d+'/'+x.name);
const runtime=files('.',/\.js$/);
for(const f of [...runtime,...files('scripts',/\.mjs$/),...files('fixtures',/\.mjs$/),...files('test',/\.js$/)]){
 const r=spawnSync(process.execPath,['--check',f],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);
}
for(const f of runtime)assert.ok(!/\b(?:from\s*|import\s*\()(['"])node:/.test(readFileSync(f,'utf8')),f+' browser dependency');
for(const f of ['manifest.json','package.json'])assert.equal(JSON.parse(readFileSync(f,'utf8')).version,VERSION,f);
console.log('Syntax checked: '+runtime.length+' browser modules, fixtures, scripts and tests; shared release version '+VERSION+'.');
