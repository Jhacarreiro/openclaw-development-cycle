#!/usr/bin/env python3
import json,os,signal,subprocess,sys,tempfile,shutil,threading
S=("DEVELOPMENT_CYCLE_CODEX_ACCESS_TOKEN","DEVELOPMENT_CYCLE_CODEX_ACCOUNT_ID","DEVELOPMENT_CYCLE_CODEX_PLAN_TYPE")
def env(home):
 e=os.environ.copy()
 for k in S+("OPENAI_API_KEY","CODEX_API_KEY","CODEX_ACCESS_TOKEN"): e.pop(k,None)
 e["CODEX_HOME"]=home; return e
def resolve_real_codex():
 explicit=os.getenv("DEVELOPMENT_CYCLE_CODEX_REAL_BIN","").strip()
 if explicit:return explicit
 self_real=os.path.realpath(__file__)
 for d in os.getenv("PATH","").split(os.pathsep):
  if not d:continue
  candidate=os.path.join(d,"codex")
  if not(os.path.isfile(candidate) and os.access(candidate,os.X_OK)):continue
  if os.path.realpath(candidate)==self_real:continue
  return candidate
 fallback="/data/npm-global/bin/codex"
 if os.path.isfile(fallback) and os.access(fallback,os.X_OK) and os.path.realpath(fallback)!=self_real:return fallback
 return ""
real=resolve_real_codex()
a=sys.argv[1:]
if not real:
 print("development-cycle codex bridge: real codex binary not found",file=sys.stderr)
 sys.exit(64)
if not a or a[0]!="exec": os.execvpe(real,[real,*a],env(os.getenv("CODEX_HOME","")))
i=1; model=""; sandbox="workspace-write"; effort=""; pos=[]
if i<len(a) and a[i]=="review": i+=1
while i<len(a):
 x=a[i]
 if x in ("--model","-m"): i+=1; model=a[i]
 elif x.startswith("--model="): model=x.split("=",1)[1]
 elif x=="--sandbox": i+=1; sandbox=a[i]
 elif x.startswith("--sandbox="): sandbox=x.split("=",1)[1]
 elif x in ("-c","--config"):
  i+=1; v=a[i]
  if v.startswith("sandbox_mode="): sandbox=v.split("=",1)[1].strip("'\"")
  if v.startswith("model_reasoning_effort="): effort=v.split("=",1)[1].strip("'\"")
 elif x not in ("--skip-git-repo-check","-") and not x.startswith("-"): pos.append(x)
 i+=1
sandbox=os.getenv("DEVELOPMENT_CYCLE_CODEX_APP_SERVER_SANDBOX",sandbox)
def resolve_openclaw_oauth():
 oc=shutil.which("openclaw")
 if not oc: raise RuntimeError("openclaw binary not found")
 root=os.path.dirname(os.path.realpath(oc))
 state=os.getenv("OPENCLAW_STATE_DIR","/data/.openclaw")
 agent=os.path.join(state,"agents","main","agent")
 js="import {ensureAuthProfileStore,resolveApiKeyForProvider} from 'openclaw/plugin-sdk/agent-runtime'; import {loadConfig} from 'openclaw/plugin-sdk/config-runtime'; const agentDir=process.env.DC_AGENT_DIR; const cfg=loadConfig(); const store=ensureAuthProfileStore(agentDir); const r=await resolveApiKeyForProvider({provider:'openai',cfg,store,agentDir,forceRefresh:false}); const p=r.profileId?store.profiles[r.profileId]:null; if(!r.apiKey||!p) throw new Error('openai oauth profile unavailable'); console.log(JSON.stringify({token:r.apiKey,accountId:p.accountId||p.email||r.profileId,planType:p.chatgptPlanType||''}));"
 e=os.environ.copy(); e["DC_AGENT_DIR"]=agent
 r=subprocess.run(["node","--input-type=module","-e",js],cwd=root,env=e,text=True,capture_output=True,timeout=30)
 if r.returncode!=0: raise RuntimeError("OpenClaw OAuth resolution failed")
 try: q=json.loads(r.stdout)
 except Exception: raise RuntimeError("OpenClaw OAuth resolution returned invalid data")
 if not q.get("token") or not q.get("accountId"): raise RuntimeError("OpenClaw OAuth resolution returned incomplete data")
 return q["token"],q["accountId"],q.get("planType","")
if not model: print("development-cycle codex bridge: missing model",file=sys.stderr); sys.exit(64)
try: tok,acc,plan=resolve_openclaw_oauth()
except Exception as e: print("development-cycle codex bridge: "+str(e),file=sys.stderr); sys.exit(78)
prompt=sys.stdin.read() or " ".join(pos)
if not prompt.strip(): prompt="Review current working-tree changes for correctness, regressions and actionable bugs."
home=tempfile.mkdtemp(prefix="dc-codex-")
p=subprocess.Popen([real,"app-server","--stdio"],cwd=os.getcwd(),env=env(home),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
def stop(signum,frame): raise SystemExit(128+signum)
signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGINT,stop)
cv=threading.Condition(); pending={}; n=1; out=[]; done=False; err=""
def send(o): p.stdin.write(json.dumps(o,separators=(",",":"))+"\n"); p.stdin.flush()
def req(m,q,t=30):
 global n
 with cv: r=n;n+=1;pending[r]=None
 send({"id":r,"method":m,"params":q})
 with cv:
  if not cv.wait_for(lambda:pending.get(r)is not None,t): raise RuntimeError(m+" timeout")
  z=pending.pop(r)
 if "error"in z: raise RuntimeError(z["error"].get("message",str(z["error"])))
 return z.get("result")
def rd():
 global done,err
 for line in p.stdout:
  try:z=json.loads(line)
  except:continue
  if "id"in z and ("result"in z or "error"in z):
   with cv:
    if z["id"]in pending:pending[z["id"]]=z;cv.notify_all()
   continue
  if "id"in z and z.get("method"):
   send({"id":z["id"],"result":{"decision":"decline","reason":"non-interactive bridge"}});continue
  m=z.get("method");q=z.get("params")or{}
  if m=="item/completed":
   it=q.get("item")or{}
   if it.get("type")=="agentMessage" and isinstance(it.get("text"),str):out.append(it["text"])
  elif m=="turn/completed":
   with cv:done=True;cv.notify_all()
  elif m=="error":
   with cv:err=(q.get("error")or{}).get("message")or q.get("message")or"app-server error";done=True;cv.notify_all()
threading.Thread(target=rd,daemon=True).start()
try:
 req("initialize",{"clientInfo":{"name":"development-cycle-octopus","version":"1"},"capabilities":{"experimentalApi":True}})
 send({"method":"initialized"})
 q={"type":"chatgptAuthTokens","accessToken":tok,"chatgptAccountId":acc}
 if plan:q["chatgptPlanType"]=plan
 req("account/login/start",q)
 z=req("thread/start",{"model":model,"modelProvider":"openai","cwd":os.getcwd(),"approvalPolicy":"never","sandbox":sandbox,"serviceName":"Claude Octopus","config":{},"environments":[],"dynamicTools":[],"experimentalRawEvents":True,"ephemeral":True})
 tid=(z.get("thread")or{}).get("id")
 q={"threadId":tid,"input":[{"type":"text","text":prompt,"text_elements":[]}],"cwd":os.getcwd(),"approvalPolicy":"never","model":model}
 if effort:q["effort"]=effort
 z=req("turn/start",q)
 if not(z.get("turn")or{}).get("id"):raise RuntimeError("no turn id")
 with cv:
  if not cv.wait_for(lambda:done,int(os.getenv("DEVELOPMENT_CYCLE_CODEX_TURN_TIMEOUT_SECONDS","1800"))):raise RuntimeError("turn timeout")
 if err:raise RuntimeError(err)
 text="".join(out).strip()
 if not text:raise RuntimeError("no assistant text")
 print(text)
except Exception as e:
 print("development-cycle codex bridge: "+str(e),file=sys.stderr);sys.exit(1)
finally:
 try:p.terminate()
 except:pass
 shutil.rmtree(home,ignore_errors=True)
