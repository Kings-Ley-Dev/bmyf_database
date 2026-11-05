require('dotenv').config({path:require('path').join(__dirname,'..','.env')}); // reads .env locally; on Vercel the dashboard variables are used
const express=require('express'),mongoose=require('mongoose'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),cookie=require('cookie-parser'),helmet=require('helmet'),cors=require('cors'),rate=require('express-rate-limit'),crypto=require('crypto'),{z}=require('zod');
const app=express();app.set('trust proxy',1);app.use(helmet(),express.json({limit:'1mb'}),cookie(),cors({origin:process.env.CLIENT_URL,credentials:true}));
app.get('/api/health',(_q,s)=>s.json({success:true,ok:true,time:new Date().toISOString()})); // for checking a deployment is alive; touches no data
let conn;app.use(async(_q,res,n)=>{try{await(conn??=mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:8000}));n()}catch(e){conn=null;console.error('Database connection failed:',e.message);res.status(503).json({success:false,message:'Cannot reach the database. Check MONGODB_URI in .env and that your IP address is allowed in MongoDB Atlas (Network Access).'})}});
// ---------- models ----------
const GROUPS=['Clegg','Wesley','Probation'],ROLES=['super_admin','admin','group_leader','attendance_officer'];
const M=(n,d,o={})=>mongoose.models[n]||mongoose.model(n,new mongoose.Schema(d,{timestamps:true,...o}));
const ref=n=>({type:mongoose.Schema.Types.ObjectId,ref:n});
const User=M('User',{fullName:String,email:{type:String,unique:true,lowercase:true,trim:true},phone:String,passwordHash:String,role:{type:String,enum:ROLES},group:{type:String,enum:GROUPS},status:{type:String,enum:['active','inactive','suspended'],default:'active'},mustChange:{type:Boolean,default:true},lastLoginAt:Date,resetHash:String,resetExp:Date});
const Counter=M('Counter',{_id:String,n:Number},{timestamps:false});
const EMP=['Employed','Unemployed','Apprentice','Student'],INV=['Lay Preacher','Lay Reader','Liturgist','Leader','Steward','Evangelist','Sunday School Teacher/Helper','Usher','Caretaker','Ministerial Student'];
const Member=M('Member',{memberId:{type:String,unique:true},fullName:{type:String,index:true},contact:{type:String,index:true},email:String,group:{type:String,enum:GROUPS,index:true},dob:{day:Number,month:Number},occupation:String,employmentStatus:{type:String,enum:EMP},churchInvolvement:[{type:String,enum:INV}],status:{type:String,enum:['Member','Visitor'],index:true},gender:{type:String,enum:['Male','Female']},residentialArea:String,dateJoined:{type:Date,default:Date.now},emergencyContact:String,emergencyContactPhone:String,notes:String,visits:[{_id:false,date:Date,event:String}],isActive:{type:Boolean,default:true}});
const EventType=M('EventType',{name:{type:String,unique:true}});
const Session=M('AttendanceSession',{name:String,type:String,date:{type:Date,index:true},startTime:String,endTime:String,location:String,description:String,createdBy:ref('User')});
const Record=M('AttendanceRecord',{sessionId:{...ref('AttendanceSession'),index:true},memberId:{...ref('Member'),index:true},status:{type:String,enum:['present','absent','excused']},recordedBy:ref('User')});
Record.schema.index({sessionId:1,memberId:1},{unique:true});
const FollowUp=M('FollowUp',{memberId:ref('Member'),reason:String,method:{type:String,enum:['Phone Call','WhatsApp','Visit','Other']},assignedTo:ref('User'),followUpDate:Date,notes:String,status:{type:String,enum:['Pending','In Progress','Completed','Unable to Reach'],default:'Pending'},createdBy:ref('User')});
const Audit=M('AuditLog',{userId:ref('User'),action:String,resource:String,resourceId:String,oldValue:{},newValue:{},ipAddress:String},{timestamps:{createdAt:'timestamp',updatedAt:false}});
// ---------- helpers ----------
const w=f=>(q,s,n)=>Promise.resolve(f(q,s,n)).catch(n),ok=(res,data,c=200)=>res.status(c).json({success:true,data}),bad=(res,c,message)=>res.status(c).json({success:false,message});
const log=(req,action,resource,resourceId,oldValue,newValue)=>Audit.create({userId:req.user?._id,action,resource,resourceId:String(resourceId||''),oldValue,newValue,ipAddress:req.ip}).catch(()=>{});
const auth=(...roles)=>async(req,res,next)=>{try{const p=jwt.verify(req.cookies.token,process.env.JWT_SECRET),u=await User.findById(p.id);if(!u||u.status!=='active')throw 0;req.user=u}catch{return bad(res,401,'Please sign in.')}
if(roles.length&&!roles.includes(req.user.role))return bad(res,403,'You do not have access to this.');next()};
const ADM=['super_admin','admin'],pad=n=>String(n).padStart(4,'0'),nextId=async()=>{const used=new Set((await Member.find().select('memberId').lean()).map(m=>parseInt(m.memberId,10)));let n=1;while(used.has(n))n++;return pad(n)}; // lowest unused number, so the ID of a deleted member is given to the next person registered
const scope=u=>u.role==='group_leader'?{group:u.group}:{};
const cookieOpts={httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict',maxAge:7*864e5};
const nodemailer=require('nodemailer');
const mail=async(to,subject,text,replyTo)=>{if(!process.env.SMTP_HOST){console.log('[email not configured] to:',to,'|',subject);return false}
try{await nodemailer.createTransport({host:process.env.SMTP_HOST,port:+process.env.SMTP_PORT||587,secure:process.env.SMTP_PORT==='465',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}}).sendMail({from:process.env.MAIL_FROM||process.env.SMTP_USER,to,subject,text,replyTo});return true}catch(e){console.error('email failed:',e.message);return false}};
// ---------- auth ----------
const lim=rate({windowMs:15*60*1000,limit:+process.env.LOGIN_RATE_LIMIT||10,message:{success:false,message:'Too many attempts. Try again later.'}}),A=express.Router();
// Super Admin sign-up: open only while NO Super Admin exists. Set SUPER_ADMIN_SETUP_KEY in .env to also require a secret key.
A.get('/super-admin-status',w(async(_q,s)=>ok(s,{available:!await User.exists({role:'super_admin'}),keyRequired:!!process.env.SUPER_ADMIN_SETUP_KEY})));
A.post('/super-admin-signup',lim,w(async(q,s)=>{const b=z.object({fullName:z.string().trim().min(2).max(100),email:z.string().trim().email(),password:z.string().min(8).max(100),setupKey:z.string().optional()}).parse(q.body);
if(await User.exists({role:'super_admin'}))return bad(s,403,'A Super Admin already exists. Please sign in instead.');
const k=process.env.SUPER_ADMIN_SETUP_KEY;if(k&&b.setupKey!==k)return bad(s,403,'The setup key is incorrect.');
const u=await User.create({fullName:b.fullName,email:b.email,passwordHash:await bcrypt.hash(b.password,12),role:'super_admin',mustChange:false});log({user:u,ip:q.ip},'CREATE','Super Admin account',u._id);ok(s,{created:true},201)}));
A.post('/login',lim,w(async(q,s)=>{const b=z.object({email:z.string().email(),password:z.string().min(1),portal:z.enum(['group_leader','attendance_officer','admin','super_admin'])}).parse(q.body),u=await User.findOne({email:b.email});
if(!u||!await bcrypt.compare(b.password,u.passwordHash))return bad(s,401,'Incorrect email or password.');if(u.status!=='active')return bad(s,403,'This account is not active. Contact an administrator.');
if(u.role!==b.portal)return bad(s,403,'This account does not belong to this login. Please use the login for your role.');u.lastLoginAt=new Date();await u.save();
s.cookie('token',jwt.sign({id:u._id},process.env.JWT_SECRET,{expiresIn:'7d'}),cookieOpts);q.user=u;log(q,'LOGIN','Auth',u._id);ok(s,{fullName:u.fullName,role:u.role,group:u.group,mustChange:u.mustChange})}));
A.post('/logout',(_q,s)=>{s.clearCookie('token',cookieOpts);ok(s,null)});
A.get('/me',auth(),(q,s)=>ok(s,{fullName:q.user.fullName,email:q.user.email,role:q.user.role,group:q.user.group,mustChange:q.user.mustChange}));
A.post('/change-password',auth(),w(async(q,s)=>{const b=z.object({current:z.string(),password:z.string().min(8)}).parse(q.body);if(!await bcrypt.compare(b.current,q.user.passwordHash))return bad(s,400,'Current password is incorrect.');
q.user.passwordHash=await bcrypt.hash(b.password,12);q.user.mustChange=false;await q.user.save();log(q,'UPDATE','Password',q.user._id);ok(s,null)}));
A.post('/forgot-password',lim,w(async(q,s)=>{const u=await User.findOne({email:String(q.body.email||'').toLowerCase()});if(u){const t=crypto.randomBytes(32).toString('hex');u.resetHash=crypto.createHash('sha256').update(t).digest('hex');u.resetExp=Date.now()+30*60*1000;await u.save();
await mail(u.email,'Reset your BMYF Database password','Use this link within 30 minutes to choose a new password:\n'+process.env.CLIENT_URL+'/reset-password?token='+t+'\n\nIf you did not ask for this, ignore this email.');}ok(s,{message:'If that email exists, a reset link has been sent.'})}));
A.post('/reset-password',lim,w(async(q,s)=>{const b=z.object({token:z.string(),password:z.string().min(8)}).parse(q.body),u=await User.findOne({resetHash:crypto.createHash('sha256').update(b.token).digest('hex'),resetExp:{$gt:Date.now()}});
if(!u)return bad(s,400,'This reset link is invalid or has expired.');u.passwordHash=await bcrypt.hash(b.password,12);u.resetHash=u.resetExp=undefined;u.mustChange=false;await u.save();log({...q,user:u},'UPDATE','Password reset',u._id);ok(s,null)}));
app.use('/api/auth',A);
// ---------- users (staff) ----------
const U=express.Router();U.use(auth(...ADM));
U.get('/',w(async(_q,s)=>ok(s,await User.find().select('-passwordHash -resetHash').sort('-createdAt'))));
U.post('/',w(async(q,s)=>{const b=z.object({fullName:z.string().min(2),email:z.string().email(),phone:z.string().optional(),role:z.enum(ROLES),group:z.enum(GROUPS).optional()}).parse(q.body);
const allowed=q.user.role==='super_admin'?ROLES.slice(1):['group_leader','attendance_officer'];if(!allowed.includes(b.role))return bad(s,403,'You cannot create this role.');
if(b.role==='group_leader'&&!['Clegg','Wesley'].includes(b.group))return bad(s,400,'A group leader must belong to Clegg or Wesley.');
const temp=crypto.randomBytes(5).toString('hex'),u=await User.create({...b,passwordHash:await bcrypt.hash(temp,12)});log(q,'CREATE','Staff',u._id,null,{email:b.email,role:b.role});
const sent=await mail(b.email,'Your BMYF Database account','Hello '+b.fullName+',\n\nSign in at '+process.env.CLIENT_URL+'/login\nEmail: '+b.email+'\nTemporary password: '+temp+'\n\nYou will be asked to change it after signing in.');ok(s,{id:u._id,emailed:sent,...(sent?{}:{temporaryPassword:temp})},201)}));
U.patch('/:id/status',w(async(q,s)=>{const st=z.enum(['active','inactive','suspended']).parse(q.body.status),u=await User.findById(q.params.id);if(!u)return bad(s,404,'Staff member not found.');
if(u.role==='super_admin'||(u.role==='admin'&&q.user.role!=='super_admin'))return bad(s,403,'You cannot change this account.');const old=u.status;u.status=st;await u.save();log(q,'UPDATE','Staff',u._id,{status:old},{status:st});ok(s,null)}));
U.post('/:id/reset',w(async(q,s)=>{const u=await User.findById(q.params.id);if(!u||u.role==='super_admin'||(u.role==='admin'&&q.user.role!=='super_admin'))return bad(s,403,'You cannot reset this account.');
const temp=crypto.randomBytes(5).toString('hex');u.passwordHash=await bcrypt.hash(temp,12);u.mustChange=true;await u.save();log(q,'UPDATE','Password reset',u._id);const sent=await mail(u.email,'Your BMYF Database password was reset','Your new temporary password is: '+temp+'\nYou will be asked to change it after signing in.');ok(s,sent?{emailed:true}:{temporaryPassword:temp})}));
// Super Admin only: permanently delete an Admin, Group Leader or Attendance Officer account.
U.delete('/:id',auth('super_admin'),w(async(q,s)=>{if(!mongoose.isValidObjectId(q.params.id))return bad(s,404,'Staff member not found.');const u=await User.findById(q.params.id);if(!u)return bad(s,404,'Staff member not found.');
if(String(u._id)===String(q.user._id))return bad(s,400,'You cannot delete your own account.');if(u.role==='super_admin')return bad(s,403,'A Super Admin account cannot be deleted.');
await Promise.all([u.deleteOne(),FollowUp.updateMany({assignedTo:u._id},{$unset:{assignedTo:1}}),ChatMessage.deleteMany({$or:[{from:u._id,to:{$ne:null}},{to:u._id}]}),ChatRead.deleteMany({$or:[{user:u._id},{peer:String(u._id)}]})]);
log(q,'DELETE','Staff',u._id,{fullName:u.fullName,email:u.email,role:u.role,group:u.group},null);ok(s,null)}));
app.use('/api/users',U);
// ---------- members ----------
const D=express.Router();D.use(auth());
const mSchema=z.object({fullName:z.string().min(2),contact:z.string().min(7),email:z.string().email().optional().or(z.literal('')),group:z.enum(GROUPS),dob:z.object({day:z.number().int().min(1).max(31),month:z.number().int().min(1).max(12)}),occupation:z.string().optional(),employmentStatus:z.enum(EMP).nullable().optional(),churchInvolvement:z.array(z.enum(INV)).optional(),status:z.enum(['Member','Visitor']),gender:z.enum(['Male','Female']).optional(),residentialArea:z.string().optional(),emergencyContact:z.string().optional(),emergencyContactPhone:z.string().optional(),notes:z.string().optional()});
D.get('/',w(async(q,s)=>{const f={...scope(q.user)},{q:t,group,status,active,gender}=q.query;if(group&&!f.group)f.group=group;if(status)f.status=status;if(gender)f.gender=gender;if(active==='true')f.isActive=true;else if(active==='false')f.isActive=false;
if(t){const r=new RegExp(String(t).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');f.$or=[{fullName:r},{memberId:r},{contact:r},{email:r},{occupation:r}]}
ok(s,await Member.find(f).sort('memberId').limit(1000))}));
D.get('/:id',w(async(q,s)=>{const m=await Member.findOne({_id:q.params.id,...scope(q.user)});if(!m)return bad(s,404,'Member not found.');
const recs=await Record.find({memberId:m._id}).populate('sessionId','name type date').sort('-createdAt'),h=recs.filter(r=>r.sessionId&&+r.sessionId.date+864e5>=+m.dateJoined).sort((a,b)=>b.sessionId.date-a.sessionId.date),c=x=>h.filter(r=>r.status===x).length;
ok(s,{member:m,history:h,summary:{total:h.length,present:c('present'),absent:c('absent'),excused:c('excused'),rate:c('present')+c('absent')?+(c('present')/(c('present')+c('absent'))*100).toFixed(1):null}})}));
D.post('/',auth('super_admin','admin','attendance_officer'),w(async(q,s)=>{const b=mSchema.parse(q.body);let m;for(let i=0;i<6&&!m;i++){try{m=await Member.create({...b,memberId:await nextId()})}catch(e){if(e.code!==11000||i===5)throw e}}log(q,'CREATE','Member',m._id,null,{memberId:m.memberId});ok(s,m,201)}));
D.put('/:id',auth(...ADM,'attendance_officer'),w(async(q,s)=>{const b=mSchema.partial().parse(q.body),m=await Member.findById(q.params.id);if(!m)return bad(s,404,'Member not found.');const old=m.toObject();Object.assign(m,b);await m.save();log(q,'UPDATE','Member',m._id,old,b);ok(s,m)}));
D.patch('/:id/convert',auth(...ADM),w(async(q,s)=>{const m=await Member.findByIdAndUpdate(q.params.id,{status:'Member',dateJoined:new Date()},{new:true});log(q,'UPDATE','Visitor converted',q.params.id);ok(s,m)}));
// Inactive / Activate: the member stays in the list (and in reports) but is left out of attendance, follow-ups and birthdays.
D.patch('/:id/active',auth(...ADM),w(async(q,s)=>{const b=z.object({active:z.boolean()}).parse(q.body),m=await Member.findByIdAndUpdate(q.params.id,{isActive:b.active},{new:true});if(!m)return bad(s,404,'Member not found.');log(q,b.active?'ACTIVATE':'INACTIVATE','Member',m._id,{isActive:!b.active},{isActive:b.active});ok(s,m)}));
// Delete: removes the member and everything recorded about them. Their ID goes to the next person registered.
D.delete('/:id',auth(...ADM),w(async(q,s)=>{const m=await Member.findById(q.params.id);if(!m)return bad(s,404,'Member not found.');await Promise.all([Record.deleteMany({memberId:m._id}),FollowUp.deleteMany({memberId:m._id}),m.deleteOne()]);log(q,'DELETE','Member',m._id,{memberId:m.memberId,fullName:m.fullName},null);ok(s,null)}));
app.use('/api/members',D);
// ---------- attendance ----------
const T=express.Router();T.use(auth());const OFF=['super_admin','admin','attendance_officer'];
const stat=recs=>{const c=x=>recs.filter(r=>r.status===x).length,p=c('present'),a=c('absent');return{present:p,absent:a,excused:c('excused'),total:recs.length,rate:p+a?+(p/(p+a)*100).toFixed(1):0}};
T.get('/',w(async(q,s)=>{const f={};if(q.query.type)f.type=q.query.type;if(q.query.from)f.date={$gte:new Date(q.query.from)};const ses=await Session.find(f).sort('-date').limit(100).lean(),recs=await Record.find({sessionId:{$in:ses.map(x=>x._id)}}).lean();
ok(s,ses.map(x=>({...x,stats:stat(recs.filter(r=>String(r.sessionId)===String(x._id)))})))}));
T.post('/',auth(...OFF),w(async(q,s)=>{const b=z.object({name:z.string().min(2),type:z.string().min(2),date:z.coerce.date(),startTime:z.string().optional(),endTime:z.string().optional(),location:z.string().optional(),description:z.string().optional()}).parse(q.body);
const x=await Session.create({...b,createdBy:q.user._id});log(q,'CREATE','Attendance',x._id,null,b);ok(s,x,201)}));
T.put('/:id',auth(...OFF),w(async(q,s)=>{const b=z.object({name:z.string().min(2),type:z.string().min(2),date:z.coerce.date(),location:z.string().optional(),description:z.string().optional()}).partial().parse(q.body),x=await Session.findById(q.params.id);if(!x)return bad(s,404,'Attendance session not found.');const old=x.toObject();Object.assign(x,b);await x.save();log(q,'UPDATE','Attendance',x._id,{name:old.name,date:old.date},b);ok(s,x)}));
T.get('/:id',w(async(q,s)=>{const x=await Session.findById(q.params.id);if(!x)return bad(s,404,'Attendance session not found.');
const members=await Member.find({isActive:true,dateJoined:{$lte:new Date(+x.date+864e5)},...scope(q.user)}).sort('fullName'),recs=await Record.find({sessionId:x._id});ok(s,{session:x,members,records:recs,stats:stat(recs)})}));
T.post('/:id/records',auth(...OFF),w(async(q,s)=>{const b=z.object({records:z.array(z.object({memberId:z.string(),status:z.enum(['present','absent','excused'])})).min(1)}).parse(q.body),x=await Session.findById(q.params.id);if(!x)return bad(s,404,'Attendance session not found.');
const ids=b.records.map(r=>r.memberId),valid=new Set((await Member.find({_id:{$in:ids},isActive:true,dateJoined:{$lte:new Date(+x.date+864e5)}}).select('_id')).map(m=>String(m._id))),old=Object.fromEntries((await Record.find({sessionId:x._id,memberId:{$in:ids}})).map(r=>[String(r.memberId),r.status]));
const ops=b.records.filter(r=>valid.has(r.memberId)).map(r=>({updateOne:{filter:{sessionId:x._id,memberId:r.memberId},update:{$set:{status:r.status,recordedBy:q.user._id}},upsert:true}}));if(ops.length)await Record.bulkWrite(ops);const pv=b.records.filter(r=>r.status==='present'&&valid.has(r.memberId)).map(r=>r.memberId);if(pv.length)await Member.updateMany({_id:{$in:pv},status:'Visitor'},{$addToSet:{visits:{date:x.date,event:x.name}}});
const changed=b.records.filter(r=>old[r.memberId]&&old[r.memberId]!==r.status);log(q,changed.length?'UPDATE':'CREATE','Attendance records',x._id,changed.map(r=>({m:r.memberId,was:old[r.memberId]})),{saved:ops.length});ok(s,{saved:ops.length,skipped:b.records.length-ops.length})}));
T.put('/:id/records/:rid',auth(...OFF),w(async(q,s)=>{const st=z.enum(['present','absent','excused']).parse(q.body.status),r=await Record.findOne({_id:q.params.rid,sessionId:q.params.id});if(!r)return bad(s,404,'Record not found.');const old=r.status;r.status=st;r.recordedBy=q.user._id;await r.save();log(q,'UPDATE','Attendance',r._id,{status:old},{status:st});ok(s,r)}));
T.delete('/:id',auth(...ADM),w(async(q,s)=>{await Record.deleteMany({sessionId:q.params.id});await Session.findByIdAndDelete(q.params.id);log(q,'DELETE','Attendance',q.params.id);ok(s,null)}));
app.use('/api/attendance',T);
// ---------- events, follow-ups, dashboard, reports, audit ----------
const DEFAULT_EVENTS=['Weekly Fellowship','Youth Service','Evangelism','Retreat','Prayer Marathon','Prayer Meeting','Bible Study','Special Program','Other'];
app.get('/api/events',auth(),w(async(_q,s)=>ok(s,[...DEFAULT_EVENTS,...(await EventType.find()).map(e=>e.name)])));
app.post('/api/events',auth(...ADM),w(async(q,s)=>{const e=await EventType.create({name:z.string().min(2).parse(q.body.name)});log(q,'CREATE','EventType',e._id);ok(s,e,201)}));
// members who missed 3+ meetings in a row (excused is neutral; meetings before joining are ignored)
// Members who still need a follow-up: 3+ absences in a row (excused/unrecorded meetings are skipped; meetings before joining are ignored).
// Only absences AFTER the member's latest follow-up (of any status) count, so completing a follow-up never puts the member straight back on the list;
// they come back only if they miss 3 more meetings in a row after being followed up.
const flagged=async(u,n=3)=>{const ses=await Session.find().sort('-date').limit(12),recs=await Record.find({sessionId:{$in:ses.map(x=>x._id)}}).lean(),map={};recs.forEach(r=>map[r.sessionId+':'+r.memberId]=r.status);
const mem=await Member.find({isActive:true,...scope(u)}),last={};
(await FollowUp.find({memberId:{$in:mem.map(m=>m._id)}}).select('memberId createdAt').lean()).forEach(f=>{const k=String(f.memberId),t=+f.createdAt;if(!(last[k]>t))last[k]=t});
const out=[];
for(const m of mem){let k=0;const since=last[String(m._id)]||0;for(const x of ses){if(+x.date+864e5<m.dateJoined)continue;if(since&&+x.date<=since)break;const r=map[x._id+':'+m._id];if(r==='absent')k++;else if(r==='present')break}if(k>=n)out.push({member:m,consecutiveAbsences:k})}
return out.sort((a,b)=>b.consecutiveAbsences-a.consecutiveAbsences)};
// Follow-up numbers. "outstanding" (the red number) = members still to check on + follow-ups that are Pending or In Progress. Completed and Unable to Reach are not outstanding.
const fuScope=async u=>u.role==='group_leader'?{memberId:{$in:(await Member.find({group:u.group}).select('_id').lean()).map(m=>m._id)}}:{};
const canTouch=async(u,memberId)=>u.role!=='group_leader'||!!await Member.exists({_id:memberId,group:u.group});
const fuCounts=async u=>{const [r,tc]=await Promise.all([FollowUp.aggregate([{$match:await fuScope(u)},{$group:{_id:'$status',n:{$sum:1}}}]),flagged(u)]),c=Object.fromEntries(r.map(x=>[x._id,x.n])),open=(c['Pending']||0)+(c['In Progress']||0);
return{...c,toCheck:tc.length,openFollowUps:open,outstanding:tc.length+open}};
const F=express.Router();F.use(auth());
F.get('/flagged',w(async(q,s)=>ok(s,await flagged(q.user))));
F.get('/summary',w(async(q,s)=>ok(s,await fuCounts(q.user))));
F.get('/',w(async(q,s)=>ok(s,await FollowUp.find({...(q.query.status?{status:String(q.query.status)}:{}),...await fuScope(q.user)}).populate('memberId','memberId fullName contact group').populate('assignedTo','fullName').sort('-createdAt'))));
F.post('/',auth(...OFF,'group_leader'),w(async(q,s)=>{const b=z.object({memberId:z.string(),reason:z.string().default('Repeated absence'),method:z.enum(['Phone Call','WhatsApp','Visit','Other']),assignedTo:z.string().optional(),followUpDate:z.coerce.date().default(()=>new Date()),notes:z.string().optional()}).parse(q.body);if(!await canTouch(q.user,b.memberId))return bad(s,403,'You can only follow up members of your own group.');const f=await FollowUp.create({...b,createdBy:q.user._id});log(q,'CREATE','Follow-up',f._id);ok(s,f,201)}));
F.put('/:id',w(async(q,s)=>{const b=z.object({status:z.enum(['Pending','In Progress','Completed','Unable to Reach']).optional(),notes:z.string().optional(),assignedTo:z.string().optional()}).parse(q.body);const cur=await FollowUp.findById(q.params.id);if(!cur)return bad(s,404,'Follow-up not found.');if(!await canTouch(q.user,cur.memberId))return bad(s,403,'You can only update follow-ups for members of your own group.');const f=await FollowUp.findByIdAndUpdate(q.params.id,b,{new:true});log(q,'UPDATE','Follow-up',f._id,{status:cur.status},b);ok(s,f)}));
app.use('/api/followups',F);
app.get('/api/dashboard',auth(),w(async(q,s)=>{const sc=scope(q.user),since=new Date(Date.now()-30*864e5),six=new Date();six.setMonth(six.getMonth()-5,1);six.setHours(0,0,0,0);
const [total,active,visitors,newM,newV,byGroup,sess,fc,recentMembers,growth,inactive,people]=await Promise.all([Member.countDocuments({status:'Member',...sc}),Member.countDocuments({status:'Member',isActive:true,...sc}),Member.countDocuments({status:'Visitor',isActive:true,...sc}),
Member.countDocuments({status:'Member',isActive:true,dateJoined:{$gte:since},...sc}),Member.countDocuments({status:'Visitor',isActive:true,dateJoined:{$gte:since},...sc}),Member.aggregate([{$match:{isActive:true,...sc}},{$group:{_id:'$group',n:{$sum:1}}}]),
Session.find().sort('-date').limit(8),fuCounts(q.user),Member.find({isActive:true,...sc}).sort('-createdAt').limit(5).select('memberId fullName group status dateJoined'),
Member.find({status:'Member',dateJoined:{$gte:six},...sc}).select('dateJoined').lean(),Member.countDocuments({status:'Member',isActive:false,...sc}),Member.find({status:'Member',isActive:true,...sc}).select('gender employmentStatus churchInvolvement').lean()]);
const tally=(rows,f,keys)=>{const o=Object.fromEntries(keys.map(k=>[k,0]));for(const r of rows)for(const x of f(r))if(x in o)o[x]++;return o}; // only the listed options; members who left a field blank are simply not counted in it
const recs=await Record.find({sessionId:{$in:sess.map(x=>x._id)}}).populate('memberId','group').lean(),of=x=>recs.filter(r=>String(r.sessionId)===String(x._id)),
trend=sess.map(x=>({_id:x._id,name:x.name,type:x.type,date:x.date,location:x.location,...stat(of(x))})).reverse(),abg=Object.fromEntries(GROUPS.map(g=>[g,stat(recs.filter(r=>r.memberId?.group===g)).rate])),
d0=new Date();d0.setHours(0,0,0,0);const todays=sess.filter(x=>x.date>=d0),months=[];
for(let i=5;i>=0;i--){const d=new Date();d.setMonth(d.getMonth()-i,1);months.push({label:d.toLocaleString('en-GB',{month:'short'}),n:growth.filter(g=>g.dateJoined.getFullYear()===d.getFullYear()&&g.dateJoined.getMonth()===d.getMonth()).length})}
ok(s,{totalMembers:total,activeMembers:active,inactiveMembers:inactive,byGender:tally(people,x=>x.gender?[x.gender]:[],['Male','Female']),byEmployment:tally(people,x=>x.employmentStatus?[x.employmentStatus]:[],EMP),byInvolvement:tally(people,x=>x.churchInvolvement||[],INV),involvedMembers:people.filter(x=>x.churchInvolvement?.length).length,peopleCount:people.length,visitors,newMembers:newM,newVisitors:newV,byGroup:Object.fromEntries(byGroup.map(g=>[g._id,g.n])),attendanceByGroup:abg,trend,latest:trend[trend.length-1]||null,today:todays.length?stat(todays.flatMap(of)):null,needFollowUp:fc.outstanding,toCheck:fc.toCheck,openFollowUps:fc.openFollowUps,pendingFollowUps:fc.Pending||0,recentMembers,recentSessions:trend.slice(-5).reverse(),growth:months})}));
// ---------- birthdays ----------
// "Today" is worked out in the church's timezone (APP_TIMEZONE, default Africa/Accra), not the server's.
const TZ=process.env.APP_TIMEZONE||'Africa/Accra',DAY=864e5,leap=y=>y%4===0&&(y%100!==0||y%400===0);
const todayIn=()=>{let p;try{p=new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}catch{p=new Date().toISOString().slice(0,10)}const[y,m,d]=p.split('-').map(Number);return{y,m,d,t:Date.UTC(y,m-1,d)}};
const bday=(dob,y)=>Date.UTC(y,dob.month-1,dob.month===2&&dob.day===29&&!leap(y)?28:dob.day); // 29 Feb is celebrated on 28 Feb in non-leap years
const birthdayPeople=async u=>({now:todayIn(),ms:await Member.find({isActive:true,'dob.day':{$exists:true},...scope(u)}).select('memberId fullName group dob').lean()});
// scope=month: the rest of THIS month only (today included, past birthdays dropped). scope=upcoming (default): the next birthdays across months.
app.get('/api/dashboard/birthdays',auth(),w(async(q,s)=>{const {now,ms}=await birthdayPeople(q.user),monthOnly=q.query.scope==='month',
row=(m,o)=>({member:{_id:m._id,memberId:m.memberId,fullName:m.fullName,group:m.group},day:new Date(o).getUTCDate(),month:new Date(o).getUTCMonth()+1,daysAway:Math.round((o-now.t)/DAY),today:o===now.t});
let L=monthOnly?ms.filter(m=>m.dob.month===now.m&&bday(m.dob,now.y)>=now.t).map(m=>row(m,bday(m.dob,now.y))):ms.map(m=>{let o=bday(m.dob,now.y);if(o<now.t)o=bday(m.dob,now.y+1);return row(m,o)});
L.sort((a,b)=>a.daysAway-b.daysAway||a.member.fullName.localeCompare(b.member.fullName));ok(s,{today:{y:now.y,m:now.m,d:now.d},items:monthOnly?L:L.slice(0,Math.min(+q.query.limit||30,200))})}));
// Number on the Birthdays menu: birthdays in the current Sunday-to-Saturday week. The week only changes on Sunday, so the number only changes on Sundays.
app.get('/api/dashboard/birthday-count',auth(),w(async(q,s)=>{const {now,ms}=await birthdayPeople(q.user),ws=now.t-new Date(now.t).getUTCDay()*DAY,we=ws+6*DAY,inWeek=m=>[now.y-1,now.y,now.y+1].some(y=>{const o=bday(m.dob,y);return o>=Math.max(ws,now.t)&&o<=we}); // only birthdays still to come: today and later this week
ok(s,{count:ms.filter(inWeek).length,weekStart:new Date(ws).toISOString().slice(0,10),weekEnd:new Date(we).toISOString().slice(0,10)})}));
const R=express.Router();R.use(auth(...OFF,'group_leader'));
R.get('/membership',w(async(q,s)=>ok(s,await Member.aggregate([{$match:scope(q.user)},{$group:{_id:{group:'$group',status:'$status',active:'$isActive'},n:{$sum:1}}}]))));
R.get('/attendance',w(async(q,s)=>{const ses=await Session.find(q.query.from?{date:{$gte:new Date(q.query.from),$lte:new Date(q.query.to||Date.now())}}:{}).sort('-date'),recs=await Record.find({sessionId:{$in:ses.map(x=>x._id)}}).populate('memberId','group').lean();
ok(s,ses.map(x=>{const r=recs.filter(y=>String(y.sessionId)===String(x._id));return{event:x.name,date:x.date,expected:r.length,...stat(r),byGroup:Object.fromEntries(GROUPS.map(g=>[g,stat(r.filter(y=>y.memberId?.group===g))]))}}))}));
R.get('/groups',w(async(_q,s)=>{const ses=await Session.find().sort('-date').limit(12),recs=await Record.find({sessionId:{$in:ses.map(x=>x._id)}}).populate('memberId','group').lean(),cnt=await Member.aggregate([{$match:{isActive:true}},{$group:{_id:{g:'$group',s:'$status'},n:{$sum:1}}}]);
ok(s,GROUPS.map(g=>({group:g,members:cnt.find(c=>c._id.g===g&&c._id.s==='Member')?.n||0,visitors:cnt.find(c=>c._id.g===g&&c._id.s==='Visitor')?.n||0,rate:stat(recs.filter(r=>r.memberId?.group===g)).rate,series:ses.slice().reverse().map(x=>({name:x.name,date:x.date,rate:stat(recs.filter(r=>String(r.sessionId)===String(x._id)&&r.memberId?.group===g)).rate}))})))}));
app.use('/api/reports',R);
app.get('/api/audit-logs',auth(...ADM),w(async(q,s)=>ok(s,await Audit.find().populate('userId','fullName').sort('-timestamp').limit(+q.query.limit||200))));
// ---------- exports (CSV, Excel, PDF) ----------
const ExcelJS=require('exceljs'),PDF=require('pdfkit'),day=d=>d?new Date(d).toISOString().slice(0,10):'';
const X=express.Router();X.use(auth(...OFF,'group_leader'));
const build={
members:async u=>({title:'Membership list',cols:['Member ID','Name','Contact','Group','Status','Active / Inactive','Gender','Employment status','Occupation','Church involvement','Birthday','Date joined'],rows:(await Member.find({...scope(u)}).sort('memberId')).map(m=>[m.memberId,m.fullName,m.contact,m.group,m.status,m.isActive===false?'Inactive':'Active',m.gender||'',m.employmentStatus||'',m.occupation||'',(m.churchInvolvement||[]).join(', '),m.dob?.day?m.dob.day+'/'+m.dob.month:'',day(m.dateJoined)])}),
attendance:async()=>{const ses=await Session.find().sort('-date').limit(200),recs=await Record.find({sessionId:{$in:ses.map(x=>x._id)}}).lean();return{title:'Attendance report',cols:['Event','Type','Date','Expected','Present','Absent','Excused','Rate %'],rows:ses.map(x=>{const a=stat(recs.filter(r=>String(r.sessionId)===String(x._id)));return[x.name,x.type,day(x.date),a.total,a.present,a.absent,a.excused,a.rate]})}},
followups:async()=>({title:'Follow-up report',cols:['Member ID','Name','Reason','Method','Assigned to','Status','Date'],rows:(await FollowUp.find().populate('memberId','memberId fullName').populate('assignedTo','fullName').sort('-createdAt')).map(f=>[f.memberId?.memberId,f.memberId?.fullName,f.reason,f.method,f.assignedTo?.fullName||'',f.status,day(f.followUpDate)])})};
X.get('/:report',w(async(q,s)=>{const b=build[q.params.report];if(!b)return bad(s,404,'Unknown report.');const{title,cols,rows}=await b(q.user),fmt=q.query.format||'csv',name='bmyf-'+q.params.report+'-'+day(new Date());
if(!['csv','xlsx','pdf'].includes(fmt))return bad(s,400,'Format must be csv, xlsx or pdf.');log(q,'EXPORT',title,'',null,{format:fmt});
if(fmt==='csv'){const e=v=>{v=String(v??'');if(/^[=@]|^[+\-](?!\d)/.test(v))v="'"+v;return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v};s.type('text/csv').attachment(name+'.csv').send('\ufeff'+[cols,...rows].map(r=>r.map(e).join(',')).join('\r\n'))}
else if(fmt==='xlsx'){const wb=new ExcelJS.Workbook(),ws=wb.addWorksheet(title);ws.addRow(cols).font={bold:true};rows.forEach(r=>ws.addRow(r));ws.columns.forEach(c=>c.width=20);s.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(name+'.xlsx');await wb.xlsx.write(s);s.end()}
else{const d=new PDF({margin:36,size:'A4',layout:'landscape'});s.type('application/pdf').attachment(name+'.pdf');d.pipe(s);d.font('Helvetica-Bold').fontSize(16).text('Beulah Methodist Youth Fellowship: '+title);d.fontSize(9).font('Helvetica').text('Generated '+new Date().toLocaleString('en-GB')+' by '+q.user.fullName).moveDown();
const cw=(d.page.width-72)/cols.length,line=(r,h)=>{const y=d.y;d.font(h?'Helvetica-Bold':'Helvetica').fontSize(8);r.forEach((v,i)=>d.text(String(v??''),36+i*cw,y,{width:cw-4,height:11,ellipsis:true}));d.y=y+15;if(d.y>d.page.height-50)d.addPage()};line(cols,1);rows.forEach(r=>line(r));d.end()}}));
app.use('/api/export',X);
// ---------- staff chat (all staff roles) ----------
// Everyone with an active account can message the "All staff" channel or any other staff member one-to-one. It refreshes by polling (Vercel serverless has no websockets).
const ChatMessage=M('ChatMessage',{from:{...ref('User'),index:true},to:{...ref('User'),default:null,index:true},text:String,deleted:{type:Boolean,default:false}}); // to = null means the All staff channel
const ChatRead=M('ChatRead',{user:ref('User'),peer:String,readAt:Date});ChatRead.schema.index({user:1,peer:1},{unique:true});
const CH=express.Router();CH.use(auth());
const chatLim=rate({windowMs:60*1000,limit:30,keyGenerator:q=>String(q.user._id),message:{success:false,message:'You are sending messages too quickly. Please wait a moment.'}});
const unreadOf=async me=>{const ra=Object.fromEntries((await ChatRead.find({user:me._id})).map(r=>[r.peer,+r.readAt])),per={};
(await ChatMessage.find({to:me._id,deleted:false,createdAt:{$gt:new Date(Date.now()-90*DAY)}}).select('from createdAt').lean()).forEach(x=>{const k=String(x.from);if(+x.createdAt>(ra[k]||0))per[k]=(per[k]||0)+1});
const channel=await ChatMessage.countDocuments({to:null,from:{$ne:me._id},deleted:false,createdAt:{$gt:new Date(ra.all||+me.createdAt)}});
return{per,channel,total:Object.values(per).reduce((a,b)=>a+b,0)+channel}};
CH.get('/unread',w(async(q,s)=>ok(s,{total:(await unreadOf(q.user)).total})));
CH.get('/people',w(async(q,s)=>{const me=q.user,[people,msgs,un,lastAll]=await Promise.all([User.find({status:'active',_id:{$ne:me._id}}).select('fullName role group').lean(),
ChatMessage.find({$or:[{from:me._id,to:{$ne:null}},{to:me._id}]}).sort('-createdAt').limit(1000).select('from to text createdAt deleted').lean(),unreadOf(me),ChatMessage.findOne({to:null}).sort('-createdAt').populate('from','fullName').lean()]),last={};
for(const x of msgs){const p=String(x.from)===String(me._id)?String(x.to):String(x.from);if(!last[p])last[p]=x}
const prev=x=>x?{text:x.deleted?'Message deleted':String(x.text).slice(0,80),at:x.createdAt,mine:String(x.from?._id||x.from)===String(me._id)}:null;
ok(s,{total:un.total,channel:{last:lastAll?{...prev(lastAll),by:lastAll.from?.fullName}:null,unread:un.channel},
people:people.map(p=>({...p,last:prev(last[String(p._id)]),unread:un.per[String(p._id)]||0})).sort((a,b)=>(+new Date(b.last?.at||0))-(+new Date(a.last?.at||0))||a.fullName.localeCompare(b.fullName))})}));
CH.get('/messages',w(async(q,s)=>{const me=q.user,who=String(q.query.with||'');let f;
if(who==='all')f={to:null};else{if(!mongoose.isValidObjectId(who)||who===String(me._id))return bad(s,400,'Choose someone to chat with.');if(!await User.exists({_id:who,status:'active'}))return bad(s,404,'That person was not found or is not active.');f={$or:[{from:me._id,to:who},{from:who,to:me._id}]}}
const rows=await ChatMessage.find(f).sort('-createdAt').limit(200).populate('from','fullName role').lean();
await ChatRead.updateOne({user:me._id,peer:who},{$set:{readAt:new Date()}},{upsert:true}); // opening a conversation marks it as read
ok(s,rows.reverse().map(x=>({_id:x._id,text:x.deleted?'':x.text,deleted:x.deleted,at:x.createdAt,mine:String(x.from?._id)===String(me._id),from:{_id:x.from?._id,fullName:x.from?.fullName||'Former staff',role:x.from?.role}})))}));
CH.post('/messages',chatLim,w(async(q,s)=>{const me=q.user,b=z.object({to:z.string(),text:z.string().trim().min(1).max(2000)}).parse(q.body);let to=null;
if(b.to!=='all'){if(!mongoose.isValidObjectId(b.to)||b.to===String(me._id))return bad(s,400,'Choose someone else to message.');if(!await User.exists({_id:b.to,status:'active'}))return bad(s,404,'That person was not found or is not active.');to=b.to}
const m=await ChatMessage.create({from:me._id,to,text:b.text});ok(s,{_id:m._id,at:m.createdAt},201)}));
CH.delete('/messages/:id',w(async(q,s)=>{const m=await ChatMessage.findById(q.params.id);if(!m)return bad(s,404,'Message not found.');if(String(m.from)!==String(q.user._id))return bad(s,403,'You can only delete your own messages.');m.deleted=true;m.text='';await m.save();ok(s,null)}));
app.use('/api/chat',CH);
// ---------- contact us (public form) ----------
// HIDDEN FOR NOW together with the Contact page and the "Website enquiries" tab. To turn them back on, uncomment this block,
// the Contact page + route + nav link and the Enquiries tab in client/src/App.jsx, and the contact test in test/smoke.js.
// const Message=M('ContactMessage',{name:String,email:String,phone:String,subject:String,message:String,read:{type:Boolean,default:false}});
// const CT=express.Router();
// CT.post('/',rate({windowMs:15*60*1000,limit:+process.env.CONTACT_RATE_LIMIT||5,message:{success:false,message:'Too many messages from this connection. Please try again later.'}}),w(async(q,s)=>{
// if(q.body?.website)return ok(s,{sent:true}); // hidden spam-trap field: bots fill it, people don't
// const b=z.object({name:z.string().trim().min(2).max(100),email:z.string().trim().email(),phone:z.string().trim().max(30).optional(),subject:z.string().trim().min(2).max(150),message:z.string().trim().min(10).max(2000)}).parse(q.body);
// await Message.create(b);await mail(process.env.CONTACT_TO||'qkingsley436@gmail.com','BMYF website message: '+b.subject,'From: '+b.name+' <'+b.email+'>\nPhone: '+(b.phone||'not given')+'\n\n'+b.message,b.email);ok(s,{sent:true},201)}));
// CT.get('/',auth(...ADM),w(async(_q,s)=>ok(s,await Message.find().sort('-createdAt').limit(200))));
// app.use('/api/contact',CT);
// ---------- errors ----------
app.use('/api',(_q,s)=>bad(s,404,'Not found.'));
app.use((e,_q,s,_n)=>{if(e instanceof z.ZodError)return bad(s,400,'Please check the required fields and try again.');if(e.code===11000)return bad(s,409,'That record already exists.');if(e.name==='CastError')return bad(s,400,'Invalid ID.');console.error(e);bad(s,500,'Something went wrong. Please try again.')});
if(require.main===module){const port=process.env.PORT||5000;
for(const k of ['MONGODB_URI','JWT_SECRET'])if(!process.env[k]){console.error('X '+k+' is missing. Open the .env file in the project folder and set it.');process.exit(1)}
conn=mongoose.connect(process.env.MONGODB_URI,{serverSelectionTimeoutMS:8000});conn.then(()=>console.log('OK MongoDB connected')).catch(e=>{conn=null;console.error('X MongoDB connection failed: '+e.message+'\n  Check MONGODB_URI in .env and, for MongoDB Atlas, that your IP address is allowed under Network Access.')});
app.listen(port,()=>console.log('OK BMYF API running on http://localhost:'+port))}
module.exports=app;
