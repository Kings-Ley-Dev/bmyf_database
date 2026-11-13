// UI smoke test: renders the real app in jsdom against a running API (see README > Testing).
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react'
import {it,expect} from 'vitest'
import App from '../src/App.jsx'  
const SA=import.meta.env.VITE_SUPER_ADMIN_PATH||'/secure-access-bmyf',SU=import.meta.env.VITE_SUPER_ADMIN_SIGNUP_PATH||'/bmyfsuperadminsignup',API=process.env.API_ORIGIN||'http://localhost:5000',E=process.env.TEST_EMAIL||'admin@test.local',P=process.env.TEST_PASSWORD||'TestPass123!'
let jar='';const real=globalThis.fetch
globalThis.fetch=async(u,o={})=>{const url=String(u).startsWith('/')?API+u:u,r=await real(url,{...o,headers:{...(o.headers||{}),cookie:jar}}),c=r.headers.getSetCookie?.();if(c?.length)jar=c.map(x=>x.split(';')[0]).join('; ');return r}
const T=x=>x instanceof RegExp?x:new RegExp('^\\s*'+x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*$','i'),head=n=>screen.findByRole('heading',{level:2,name:T(n)},{timeout:15000}),go=async(link,title)=>{fireEvent.click(screen.getAllByText(T(link))[0]);await head(title)}
it('super admin sign-up page works once',async()=>{cleanup();window.history.pushState({},'',SU);const {container}=render(<App/>)
  await screen.findByText(/Create the one Super Admin account|A Super Admin account already exists/,{},{timeout:15000})
  if(screen.queryByText('Create account')){const set=(n,v)=>fireEvent.change(container.querySelector('[name='+n+']'),{target:{value:v}});set('fullName','Test Admin');set('email',E);set('password',P);set('confirm',P);fireEvent.click(screen.getByText(T('Create account')));await screen.findByText(T('Super Admin Login'),{},{timeout:15000})}
  else expect(screen.getByText(T('Go to Super Admin sign in'))).toBeTruthy()
})
it('signs in and every screen renders',async()=>{
  const errs=[];const ce=console.error;console.error=(...a)=>{errs.push(a.map(String).join(' ').slice(0,200))}
  window.history.pushState({},'','/');render(<App/>)
  expect(await screen.findByText(/Every member\./i)).toBeTruthy()
  for(const t of ['Group Leader','Attendance Officer','Admin'])expect(screen.getAllByText(t).length).toBeGreaterThan(0)
  expect(screen.queryByText('Super Admin')).toBeNull()
  cleanup();window.history.pushState({},'',SA);const {container}=render(<App/>)
  await screen.findByText(T('Super Admin Login'))
  fireEvent.change(container.querySelector('input[type=email]'),{target:{value:E}});fireEvent.change(container.querySelector('input[type=password]'),{target:{value:P}})
  fireEvent.click(screen.getByText(T('Sign in')));await head('Administrator Dashboard')
  await screen.findByText(T('Membership growth'));await screen.findByText(T('Recent members'))
  for(const h of ['Gender Distribution','Employment Distribution','Church Involvement Distribution','Group Distribution'])await screen.findByText(T(h))
  await fetch('/api/members',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fullName:'UI Test Person',contact:'0241234567',group:'Wesley',status:'Member',dob:{day:5,month:10}})})
  await go('Members','Members');await screen.findByText(T('Register member'),{exact:false},{timeout:15000}).catch(()=>{})
  fireEvent.click(screen.getByText(T('+ Register member')));await screen.findByText(T('Register new member'));await screen.findByText(T('Employment Status'));await screen.findByText(T('Church Involvement'));expect(screen.getByLabelText('Usher').type).toBe('checkbox');const lbl=Array.from(document.querySelectorAll('label')).map(l=>l.textContent);expect(lbl.indexOf('Employment Status')).toBeLessThan(lbl.indexOf('Occupation'));expect(lbl.indexOf('Occupation')).toBeLessThan(lbl.indexOf('Church Involvement'));fireEvent.click(screen.getByText(T('Cancel')))
  fireEvent.click((await screen.findAllByText('UI Test Person'))[0]);const ib=await screen.findByRole('button',{name:'Inactive Member'}),bs=Array.from(ib.parentElement.querySelectorAll('button')).map(b=>b.textContent);expect(bs.indexOf('Inactive Member')).toBeLessThan(bs.indexOf('Delete Member'));expect(bs.indexOf('Delete Member')).toBeGreaterThan(-1);expect(bs.includes('Deactivate member')).toBe(false)
  fireEvent.click(ib);fireEvent.click(await screen.findByRole('button',{name:'Activate Member'},{timeout:15000}));await screen.findByRole('button',{name:'Inactive Member'},{timeout:15000});fireEvent.click(screen.getByText('Close'))
  await go('Visitors','Visitors')
  await go('Attendance','Attendance');fireEvent.click(screen.getByText(T('+ Create attendance')));await screen.findByText(T('Event name *'))
  fireEvent.click(screen.getAllByText(T('Create attendance')).pop());await head('BMYF Weekly Fellowship');await screen.findByText(T('Mark all present'))
  fireEvent.click(screen.getByText(T('Mark all present')));fireEvent.click(screen.getByText(T('Save attendance')));await head('Attendance')
  await go('Follow-ups','Follow-ups');await screen.findByText(T('Members to check on'))
  const now=new Date();await fetch('/api/members',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fullName:'UI Birthday Today',contact:'0249876543',group:'Wesley',status:'Member',dob:{day:now.getUTCDate(),month:now.getUTCMonth()+1}})})
  await go('Birthdays','Birthdays');await screen.findAllByText(/UI Birthday Today/);await screen.findAllByText(/Birthday today/i)
  await go('Messages','Messages');expect(screen.queryByText(/Website enquiries/i)).toBeNull();await screen.findByText(/Choose a person or All staff/i)
  fireEvent.click(await screen.findByText(/^All staff$/i,{selector:'*'}).catch(()=>screen.getAllByText(/All staff/i)[0]));await screen.findByPlaceholderText(/message/i)
  fireEvent.change(screen.getByPlaceholderText(/message/i),{target:{value:'Hello team from the UI test'}});fireEvent.click(screen.getByText(/^Send$/i));await screen.findByText('Hello team from the UI test',{},{timeout:15000})
  await go('Reports','Reports');await screen.findByText(T('Group report'));await screen.findByText(T('Individual report'))
  await fetch('/api/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fullName:'UI Delete Me',email:'ui.delete.me@test.local',role:'attendance_officer'})})
  await go('Staff','Staff');const row=(await screen.findByText('UI Delete Me')).closest('.mk');window.confirm=()=>true;fireEvent.click(Array.from(row.querySelectorAll('button')).find(b=>/^delete$/i.test(b.textContent)));await waitFor(()=>expect(screen.queryByText('UI Delete Me')).toBeNull(),{timeout:15000});
  await go('Audit Logs','Audit logs');await go('System Settings','System Settings');await screen.findByText(T('Event types'))
  await go('My Profile','My Profile');await screen.findByText(T('Change password'))
  fireEvent.click(screen.getByText(T('Log out')));await screen.findByText(/Every member\./i)
  console.error=ce;const real=errs.filter(e=>!/act\(|not wrapped|Not implemented: navigation/.test(e));expect(real).toEqual([])
})
it('home page: only Sign in in the navbar, sections in order, no About or Contact',async()=>{
  cleanup();window.history.pushState({},'','/');const {container}=render(<App/>)
  await screen.findByText(/Every member\./i)
  for(const n of ['About','Contact','Contact us','About BMYF','Learn more','Sign in to BMYF Database'])expect(screen.queryByText(n)).toBeNull()
  expect(container.querySelectorAll('nav a').length).toBe(2)
  const pos=id=>container.querySelector('#'+id),before=(a,b)=>!!(pos(a).compareDocumentPosition(pos(b))&Node.DOCUMENT_POSITION_FOLLOWING)
  expect(pos('signin')).toBeTruthy();expect(before('signin','groups')).toBe(true);expect(container.querySelector('#about')).toBeNull()
  // The Executive Body section may be hidden (commented out); when it is shown, check its order and cards.
  if(pos('executives')){expect(before('groups','executives')).toBe(true);expect(container.querySelectorAll('.ex').length).toBe(10);expect(screen.getByText('Prayer & Evangelism Coordinator')).toBeTruthy()}
  expect(screen.getAllByText(/Kingsley Quarshie/).length>0).toBe(true)
  expect(container.querySelector('.hero .wrap').lastElementChild.classList.contains('ring')).toBe(true)
  cleanup();window.history.pushState({},'','/contact');render(<App/>);await screen.findByText(/Every member\./i)
})
