// Isolated fixture protocol. No fetch, globals, DOM, ST events or executable tool. Never used in production.
export function readDeclaredText({finish,tool,parts}){
    if(finish!=='STOP'||tool||!Array.isArray(parts)||parts.length!==1||typeof parts[0]!=='string')return null;
    const begin='[fixture text]\n',end='\n[/fixture text]',v=parts[0];
    if(v.length>4096||!v.startsWith(begin)||!v.endsWith(end))return null;
    const t=v.slice(begin.length,-end.length);
    return t.trim()&&!/\[\/?fixture text\]/i.test(t)?t:null;
}
