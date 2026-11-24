import { GUIDES, EFFECTS } from './setting-help.js?v=1.4.3';
// DOM-only view helpers. A change writes a preference; navigation never changes a request mode.
export function el(tag, props = {}, text = '') {
    const node = document.createElement(tag);
    Object.assign(node, props);
    if (text) node.textContent = text;
    return node;
}
export const note = text => el('p', { className: 'lpg-hint' }, text);
export function action(text, fn, cls = '') {
    const b = el('button', { type: 'button', className: 'lpg-button '+cls }, text);
    b.addEventListener('click', fn);
    return b;
}
export function intro(title, summary) {
    const div=el('header',{className:'lpg-intro'});
    div.append(el('h3',{},title),note(summary)); return div;
}
export function group(title, description) {
    const section=el('section',{className:'lpg-group'});
    section.append(el('h4',{},title)); if(description)section.append(note(description)); return section;
}
export function detail(title, description) {
    const box=el('details',{className:'lpg-advanced'});
    box.append(el('summary',{},title)); if(description)box.append(note(description)); return box;
}
export function notice() { return el('p',{className:'lpg-notice'}); }

export function controls(read, write) {
    function identify(input,key,description) {
        input.dataset.setting=key; input.id='lpg-set-'+key;
        if(description)input.setAttribute('aria-describedby',input.id+'-help');
    }
    function help(key,text) { return el('span',{id:'lpg-set-'+key+'-help',className:'lpg-help'},text); }
    function labelFor(key,label) { return el('label',{htmlFor:'lpg-set-'+key,className:'lpg-label'},label); }
    function guide(key,label,kind) {
        const [how,example]=GUIDES[key];
        const box=el('details',{className:'lpg-helpbox'});box.dataset.guide=key;
        const title=el('summary',{},kind==='check'?'怎么开？开关对比':'怎么选？看个例子');
        title.setAttribute('aria-label',label+'：'+title.textContent);
        box.append(title);
        for(const [name,copy] of [['怎么选',how],['实际例子',example]]){
            const line=el('p');line.append(el('b',{},name+'：'),document.createTextNode(copy));box.append(line);
        }
        return box;
    }
    function described(control,key,label,kind) {
        const box=el('div',{className:'lpg-setting'});box.append(control);
        if(Object.hasOwn(EFFECTS,key)){
            const effect=el('p',{className:'lpg-effect'});effect.dataset.effect=key;box.append(effect);
        }
        box.append(guide(key,label,kind));return box;
    }
    return {
        select(label,key,options,description='') {
            const field=el('div',{className:'lpg-field'});
            const input=el('select',{className:'text_pole lpg-select'});
            identify(input,key,description);
            options.forEach(([value,text])=>input.append(el('option',{value},text)));
            input.value=read()[key]; input.addEventListener('change',()=>write(key,input.value));
            field.append(labelFor(key,label),input);
            if(description)field.append(help(key,description)); return described(field,key,label);
        },
        check(label,key,description='') {
            const row=el('label',{className:'lpg-check',htmlFor:'lpg-set-'+key});
            const input=el('input',{type:'checkbox',checked:read()[key]});
            identify(input,key,description); input.addEventListener('change',()=>write(key,input.checked));
            const word=el('span',{className:'lpg-check-word'});word.append(el('span',{className:'lpg-label'},label));
            if(description)word.append(help(key,description));
            row.append(word,input); return described(row,key,label,'check');
        },
        text(label,key,maxLength,description='') {
            const field=el('div',{className:'lpg-field'});
            const input=el('textarea',{className:'text_pole',rows:key==='prefill'?4:3,maxLength,value:read()[key]});
            identify(input,key,description); input.addEventListener('input',()=>write(key,input.value));field.append(labelFor(key,label),input);if(description)field.append(help(key,description));return described(field,key,label);
        },
        choice(label,key,description,choices) {
            // Each entire option is a tap target. Native radios also support keyboard arrows and screen readers.
            const field=el('fieldset',{className:'lpg-choices'}); field.setAttribute('aria-describedby','lpg-set-'+key+'-help');
            field.append(el('legend',{},label),help(key,description));
            for(const [value,title] of choices) {
                const id='lpg-choice-'+key+'-'+value, wrap=el('label',{htmlFor:id,className:'lpg-choice'});
                const radio=el('input',{type:'radio',name:'lpg-choice-'+key,id,value,checked:read()[key]===value});
                radio.dataset.setting=key;
                radio.addEventListener('change',()=>{if(radio.checked)write(key,value);});
                wrap.append(radio,el('span',{},title)); field.append(wrap);
            }
            field.append(el('p',{className:'lpg-choice-example lpg-choice-info-'+key}));
            return described(field,key,label);
        }
    };
}

export function tabs(items, notify) {
    const bar=el('div',{className:'lpg-tabs'});bar.setAttribute('role','tablist');bar.setAttribute('aria-label','设置分类');
    const pages={}, buttons={}; const ids=items.map(x=>x[0]);
    let selected;
    function show(id,focus=false,remember=true) {
        if(!ids.includes(id))return;
        selected=id;
        for(const item of ids) {
            const active=item===id; pages[item].hidden=!active;
            buttons[item].tabIndex=active?0:-1;
            buttons[item].setAttribute('aria-selected',String(active));
        }
        if(remember)try{sessionStorage.setItem('lpg.ui.tab.v1',id);}catch{/* optional UI preference */}
        if(focus)buttons[id].focus();
        notify?.(id);
    }
    for(const [id,title] of items){
        const tab=el('button',{type:'button',id:'lpg-tab-'+id,className:'lpg-tab'},title);
        const page=el('section',{id:'lpg-page-'+id,className:'lpg-page',hidden:true});
        tab.setAttribute('role','tab');tab.setAttribute('aria-controls',page.id);
        page.setAttribute('role','tabpanel');page.setAttribute('aria-labelledby',tab.id);
        tab.addEventListener('click',()=>show(id));
        tab.addEventListener('keydown',e=>{
            const i=ids.indexOf(id), j={ArrowLeft:(i+ids.length-1)%ids.length,ArrowRight:(i+1)%ids.length,Home:0,End:ids.length-1}[e.key];
            if(j===undefined)return;e.preventDefault();show(ids[j],true);
        });
        pages[id]=page;buttons[id]=tab;bar.append(tab);
    }
    let stored;try{stored=sessionStorage.getItem('lpg.ui.tab.v1');}catch{/* optional */}
    show(ids.includes(stored)?stored:ids[0],false,false);
    return {bar,pages,show,current:()=>selected};
}
