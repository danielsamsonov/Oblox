// Server-side validation for portable, declarative worlds. Never executes authored code.
const PARTS = new Set(['block','sphere','cylinder','wedge','kill','coin','pad','checkpoint','spawn','finish','teleport','tree','pine','rock','crate','lamp','light','sign','door','button','conveyor','ladder','chest','barrel','fence','model','speaker']);
const ACTIONS = new Set(['coins','damage','heal','kill','bounce','teleport','message','toggle','spin','move','show_ui','hide_ui','sound','music','win','create_value','set_value','add_value','multiply_value','random_value','if_value','repeat','wait','emit_signal','set_text','set_texture','play_asset','music_asset','set_color','set_visible','set_collision','set_position','rotate','destroy']);
const MATERIALS = new Set(['plastic','neon','glass','metal','wood','ice','smooth']);
const SOUNDS = new Set(['coin','jump','win','checkpoint','pad','boom','thunder','alarm','buy','oof']);
const TRACKS = new Set(['menu','lobby','isles','obby','city','lava','rush','disaster']);
const UI_KINDS = new Set(['text','button','panel','icon','coins','timer','health']);
const EVENTS = new Set(['touch','start','timer','leave','interact','value_changed','signal','respawn','death']);
const SKIES = new Set(['day','night','sunset']);
const GENRES = new Set(['Obby','Adventure','Roleplay','Survival','Arcade']);
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const ASSET = /^[a-f0-9]{64}$/;
function fail(message,status=400,code='validation_failed') {const e=new Error(message);e.status=status;e.code=code;throw e;}
const object = (v) => v && typeof v==='object' && !Array.isArray(v);
const text = (s,n=100) => String(s==null?'':s).replace(/[\u0000-\u001f<>]/g,'').slice(0,n).trim();
function number(v,min,max,fallback) {if(v===undefined&&fallback!==undefined)return fallback;if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max)fail('number outside supported range');return v;}
function vector(v,fallback,min=-10000,max=10000) {if(v===undefined)return fallback;if(!Array.isArray(v)||v.length!==3)fail('vector must contain three numbers');return v.map(n=>number(n,min,max));}
function color(v,fallback) {if(v===undefined)return fallback;if(typeof v!=='string'||!/^(?:[a-f0-9]{6}|[a-f0-9]{8})$/i.test(v))fail('invalid color');return v.toLowerCase();}
function enumValue(v,choices,fallback) {if(v===undefined)return fallback;if(!choices.has(v))fail('unsupported value: '+text(v,40));return v;}
function list(v,max,fallback=[]) {if(v===undefined)return fallback;if(!Array.isArray(v)||v.length>max)fail('too many items');return v;}
function boolean(v,fallback) {if(v===undefined)return fallback;if(typeof v!=='boolean')fail('expected a boolean');return v;}
function key(v) {if(typeof v!=='string'||!KEY.test(v))fail('invalid value or signal name');return v;}
function primitive(v) {if(typeof v==='boolean')return v;if(typeof v==='string')return v.slice(0,1000);if(typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e12)return v;fail('value must be a number, text or boolean');}
function asset(v) {if(v===undefined||v==='')return '';if(typeof v!=='string'||!ASSET.test(v))fail('invalid asset id');return v;}
function validateWorld(raw) {
  if(!object(raw))fail('creation must be an object');
  const title=text(raw.title,80);if(!title)fail('add a title before publishing');
  const parts=list(raw.parts,1000);if(!parts.length||!parts.some(p=>object(p)&&p.t==='spawn'))fail('add a Spawn before publishing');
  let actionCount=0;
  function actions(value,depth=0) {if(depth>4)fail('visual code is nested too deeply');return list(value,64).map(item=>{
    if(!object(item)||!ACTIONS.has(item.a))fail('unsupported action');if(++actionCount>2000)fail('too many actions');
    const out={a:item.a};
    if(['coins','damage','heal','bounce','spin','move'].includes(item.a))out.n=number(item.n,-10000,10000,item.a==='move'?2:1);
    if(item.a==='move')out.xyz=vector(item.xyz,[0,4,0],-1000,1000);
    if(['teleport','toggle','set_text','set_texture','set_color','set_visible','set_collision','set_position','rotate','destroy'].includes(item.a))out.target=text(item.target,64);
    if(['show_ui','hide_ui','set_text'].includes(item.a))out.ui=text(item.ui,64);
    if(['message','set_text'].includes(item.a))out.text=text(item.text,1000);
    if(item.a==='sound')out.sound=enumValue(item.sound,SOUNDS,'coin');
    if(item.a==='music')out.track=enumValue(item.track,TRACKS,'menu');
    if(['create_value','set_value','add_value','multiply_value','random_value','if_value','emit_signal'].includes(item.a))out.key=key(item.key);
    if(['create_value','set_value','if_value'].includes(item.a))out.value=primitive(item.value);
    if(['add_value','multiply_value'].includes(item.a))out.n=number(item.n,-1e9,1e9,1);
    if(item.a==='random_value'){out.min=number(item.min,-1e9,1e9,0);out.max=number(item.max,-1e9,1e9,100);if(out.min>out.max)fail('random minimum exceeds maximum');}
    if(item.a==='if_value'){out.op=enumValue(item.op,new Set(['eq','ne','gt','gte','lt','lte','contains']),'eq');out.do=actions(item.do,depth+1);out.else=actions(item.else,depth+1);}
    if(item.a==='repeat'){out.n=number(item.n,1,100,1);if(!Number.isInteger(out.n))fail('repeat count must be an integer');out.do=actions(item.do,depth+1);}
    if(item.a==='wait')out.n=number(item.n,0,60,1);
    if(item.a==='set_texture')out.texture_asset=asset(item.texture_asset);
    if(['play_asset','music_asset'].includes(item.a))out.sound_asset=asset(item.sound_asset);
    if(item.a==='set_color')out.color=color(item.color,'ffffff');
    if(item.a==='set_visible')out.visible=boolean(item.visible,true);
    if(item.a==='set_collision')out.collide=boolean(item.collide,true);
    if(['set_position','rotate'].includes(item.a))out.xyz=vector(item.xyz,[0,0,0]);
    return out;
  });}
  const names=new Set();
  const sanitizedParts=parts.map((p,i)=>{
    if(!object(p)||!PARTS.has(p.t))fail('unsupported part');const name=text(p.name,64)||'Part'+(i+1);if(names.has(name))fail('part names must be unique');names.add(name);
    const out={t:p.t,name,p:vector(p.p,[0,0,0]),folder:text(p.folder,64),rot:p.rot===undefined?[0,number(p.r,-36000,36000,0),0]:vector(p.rot,[0,0,0],-36000,36000),anchored:boolean(p.anchored,true),collide:boolean(p.collide,true),alpha:number(p.alpha,0,1,1)};
    if(p.s!==undefined)out.s=vector(p.s,undefined,0.1,512);if(p.c!==undefined)out.c=color(p.c);if(p.mat!==undefined)out.mat=enumValue(p.mat,MATERIALS);
    if(p.t==='sign')out.text=text(p.text,1000);if(p.t==='light')out.n=number(p.n,0,20,2);if(p.t==='teleport')out.target=text(p.target,64);
    if(p.speed!==undefined)out.speed=number(p.speed,-50,50,4);
    if(p.texture_asset!==undefined)out.texture_asset=asset(p.texture_asset);if(p.model_asset!==undefined)out.model_asset=asset(p.model_asset);
    out.events=list(p.events,32).map(ev=>{if(!object(ev)||!EVENTS.has(ev.on))fail('unsupported event');const result={on:ev.on,do:actions(ev.do)};if(ev.on==='timer')result.every=number(ev.every,0.25,86400,2);if(['value_changed','signal'].includes(ev.on))result.key=key(ev.key);return result;});
    return out;
  });
  const ids=new Set();
  const ui=list(raw.ui,100).map((el,i)=>{
    if(!object(el)||!UI_KINDS.has(el.k))fail('unsupported UI element');const id=text(el.id,64)||'UI'+(i+1);if(ids.has(id))fail('UI ids must be unique');ids.add(id);
    const out={id,k:el.k,x:number(el.x,-1600,3200,0),y:number(el.y,-900,1800,0),w:number(el.w,8,3200,200),h:number(el.h,8,1800,60),text:text(el.text,1000),size:number(el.size,8,160,24),color:color(el.color,'ffffff'),bg:color(el.bg,'00000000'),radius:number(el.radius,0,100,12),visible:boolean(el.visible,true),click:actions(el.click)};
    if(el.image_asset!==undefined)out.image_asset=asset(el.image_asset);return out;
  });
  if(raw.values!==undefined&&!object(raw.values))fail('values must be an object');const values={};
  if(Object.keys(raw.values||{}).length>128)fail('too many values');for(const [k,v] of Object.entries(raw.values||{}))Object.defineProperty(values,key(k),{value:primitive(v),enumerable:true});
  for(const entry of list(raw.assets,64))if(!object(entry)||!ASSET.test(entry.id||''))fail('invalid asset manifest');
  const result={schema_version:2,title,desc:text(raw.desc===undefined?raw.description:raw.desc,2000),parts:sanitizedParts,ui,values,assets:[],folders:list(raw.folders,100).map(f=>text(f,64)),sky:enumValue(raw.sky,SKIES,'day'),music:enumValue(raw.music,TRACKS,'isles'),genre:enumValue(raw.genre,GENRES,'Obby'),published:true};
  for(const field of ['music_asset','thumbnail_asset'])if(raw[field]!==undefined)result[field]=asset(raw[field]);
  collectReferences(result);return result;
}
function collectReferences(creation) {
  const refs=new Map();function add(id,kind){if(!id)return;if(refs.has(id)&&refs.get(id)!==kind)fail('one asset cannot have different media kinds');refs.set(id,kind);}
  function actions(items){for(const a of items||[]){add(a.texture_asset,'texture');add(a.sound_asset,'sound');actions(a.do);actions(a.else);}}
  add(creation.music_asset,'sound');add(creation.thumbnail_asset,'texture');
  for(const p of creation.parts||[]){add(p.texture_asset,'texture');add(p.model_asset,'model');for(const e of p.events||[])actions(e.do);}
  for(const el of creation.ui||[]){add(el.image_asset,'texture');actions(el.click);}
  if(refs.size>64)fail('too many referenced assets');return [...refs].map(([id,kind])=>({id,kind}));
}
module.exports={validateWorld,collectReferences};
