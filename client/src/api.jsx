import {useEffect,useState} from 'react'
const BASE=import.meta.env.VITE_API_URL||''
const NOAPI='Cannot reach the server. If you are running this on your computer, the API is not running: open the project folder in a terminal and run "npm run dev".'
export async function api(path,o={}){
  let r;try{r=await fetch(BASE+'/api'+path,{credentials:'include',...o,headers:{'Content-Type':'application/json'},body:o.body&&JSON.stringify(o.body)})}catch{throw new Error(NOAPI)}
  const j=await r.json().catch(()=>null)
  if(!r.ok)throw new Error(j?.message||(r.status>=500?NOAPI:'Something went wrong. Please try again.'))
  return j.data
}
export function useLoad(path,ms){
  const [s,set]=useState({}),[n,setN]=useState(0)
  useEffect(()=>{if(!path)return;let live=true;set(p=>({...p,err:null}));api(path).then(data=>live&&set({data})).catch(e=>live&&set(p=>({...p,err:e.message})));return()=>{live=false}},[path,n])
  useEffect(()=>{if(!ms)return;const t=setInterval(()=>{if(document.visibilityState!=='hidden')setN(v=>v+1)},ms);return()=>clearInterval(t)},[ms])
  return {...s,reload:()=>setN(v=>v+1)}
}
// Tells the sidebar to re-read its red numbers right away (after a follow-up changes, a chat is read, and so on)
export const refreshBadges=()=>window.dispatchEvent(new Event('bmyf-badges'))
let push;export const toast=m=>push&&push(m)
export function Toasts(){const [m,setM]=useState('');useEffect(()=>{push=t=>{setM(t);setTimeout(()=>setM(''),2600)}},[]);return m?<div className="toast">{m}</div>:null}
export async function download(path,name){const r=await fetch(BASE+'/api'+path,{credentials:'include'});if(!r.ok)throw new Error('Export failed. Please try again.');const u=URL.createObjectURL(await r.blob()),a=document.createElement('a');a.href=u;a.download=name;a.click();URL.revokeObjectURL(u)}
