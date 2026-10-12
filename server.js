'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const WORLD_W = 4800, TILE = 24, COLS = WORLD_W / TILE, ROWS = 38, WORLD_H = TILE * ROWS;
const BLUE = 1, RED = 2, MAX_SHADOW = 100;
const rooms = new Map();
const mime = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') { res.writeHead(200, {'content-type':'text/plain; charset=utf-8'}); return res.end('ok'); }
  let pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const file = path.normalize(path.join(ROOT, pathname));
  if (!file.startsWith(ROOT + path.sep) && file !== path.join(ROOT,'index.html')) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, {'content-type':'text/plain; charset=utf-8'}); return res.end('Not found'); }
    res.writeHead(200, {'content-type':mime[path.extname(file)] || 'application/octet-stream', 'cache-control':'no-store'}); res.end(data);
  });
});
const wss = new WebSocket.Server({ noServer: true, maxPayload: 8192 });
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
function send(ws, obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room, obj) { for (const ws of room.clients.values()) send(ws, obj); }
function cleanName(s) { return String(s || 'Player').replace(/[<>\n\r]/g,'').trim().slice(0,16) || 'Player'; }
function newCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code; do { code = ''; for (let i=0;i<5;i++) code += chars[crypto.randomInt(chars.length)]; } while (rooms.has(code));
  return code;
}
function publicRoom(room) {
  return { code:room.code, hostId:room.hostId, status:room.status,
    players:[...room.clients.values()].map(ws=>({id:ws.session.id,name:ws.session.name,host:ws.session.id===room.hostId})),
    maxPlayers:6, gameMode:room.gameMode || null };
}
function sendRoom(room) { broadcast(room, {type:'room', room:publicRoom(room)}); }
function getClientRoom(ws) { return ws.session && ws.session.roomCode ? rooms.get(ws.session.roomCode) : null; }
function assignTeams(humans, fillBots) {
  const counts = { [BLUE]:0, [RED]:0 }, list=[];
  let tieTeam = BLUE;
  for (const h of humans) {
    let team;
    if (counts[BLUE] < counts[RED]) team=BLUE;
    else if (counts[RED] < counts[BLUE]) team=RED;
    else { team=tieTeam; tieTeam = tieTeam===BLUE?RED:BLUE; }
    counts[team]++;
    list.push(createPlayer({id:h.session.id,name:h.session.name,team,isCpu:false}));
  }
  if (fillBots) {
    let n=1;
    while (list.length<6) {
      const team = counts[BLUE] < counts[RED] ? BLUE : counts[RED] < counts[BLUE] ? RED : (tieTeam===BLUE?RED:BLUE);
      tieTeam = team===BLUE?RED:BLUE; counts[team]++;
      list.push(createPlayer({id:`cpu-${n}-${crypto.randomBytes(3).toString('hex')}`,name:`CPU ${n++}`,team,isCpu:true}));
    }
  }
  for (const team of [BLUE,RED]) {
    const pack=list.filter(p=>p.team===team);
    pack.forEach((p,i)=>{
      p.index=i; p.spawnX=team===BLUE?WORLD_W*.12:WORLD_W*.88;
      const frac=pack.length===1?.5:(.22+i*(.56/(pack.length-1)));
      p.spawnY=WORLD_H*frac; p.x=p.spawnX+(Math.random()-.5)*18; p.y=p.spawnY+(Math.random()-.5)*30;
      p.angle=team===BLUE?0:Math.PI;
    });
  }
  return list;
}
function createPlayer({id,name,team,isCpu}) {
  return {id,name,team,isCpu:!!isCpu,index:0,x:0,y:0,spawnX:0,spawnY:0,r:15,angle:team===BLUE?0:Math.PI,
    shadow:MAX_SHADOW,alive:true,respawn:0,cooldown:Math.random()*.2,kills:0,deaths:0,
    input:{moveX:0,moveY:0,aim:team===BLUE?0:Math.PI,fire:false},weaponId:0,chargeTime:0,wasFiring:false,pendingCharge:0,strafe:Math.random()<.5?-1:1};
}
function startGame(room, fillBots) {
  if (room.status!=='lobby') return;
  const humans=[...room.clients.values()]; if (!humans.length) return;
  room.gameMode=fillBots?'cpu-fill':'current-players';
  const players=assignTeams(humans,fillBots);
  const g={worldW:WORLD_W,worldH:WORLD_H,tile:TILE,cols:COLS,rows:ROWS,players,bullets:[],territory:new Int8Array(COLS*ROWS),scores:{blue:0,red:0},timeLeft:180,ended:false,events:[],paintChanges:[],tick:0};
  room.game=g;room.status='running';
  for (const p of players) for (let yy=-5;yy<=5;yy++) for(let xx=-5;xx<=5;xx++) paintCell(g,p.spawnX+xx*TILE,p.spawnY+yy*TILE,p.team);
  const seed=[]; for(let i=0;i<g.territory.length;i++) if(g.territory[i]) seed.push([i,g.territory[i]]);
  for(const ws of room.clients.values()) send(ws,{type:'gameStart',meId:ws.session.id,worldW:g.worldW,worldH:g.worldH,tile:g.tile,cols:g.cols,rows:g.rows,territory:seed,mode:room.gameMode});
  sendRoom(room); broadcast(room,{type:'state',state:snapshot(g)});
}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function cellIndex(x,y){const tx=Math.floor(x/TILE),ty=Math.floor(y/TILE);if(tx<0||ty<0||tx>=COLS||ty>=ROWS)return -1;return ty*COLS+tx;}
function paintCell(g,x,y,team){const idx=cellIndex(x,y);if(idx<0||g.territory[idx]===team)return;g.territory[idx]=team;g.paintChanges.push([idx,team]);}
function paintBrush(g,x,y,team,radius=TILE*1.6){const minX=Math.max(0,Math.floor((x-radius)/TILE)),maxX=Math.min(COLS-1,Math.floor((x+radius)/TILE)),minY=Math.max(0,Math.floor((y-radius)/TILE)),maxY=Math.min(ROWS-1,Math.floor((y+radius)/TILE));for(let ty=minY;ty<=maxY;ty++)for(let tx=minX;tx<=maxX;tx++){const left=tx*TILE,right=left+TILE,top=ty*TILE,bottom=top+TILE,cx=clamp(x,left,right),cy=clamp(y,top,bottom);if(Math.hypot(x-cx,y-cy)<=radius)paintCell(g,tx*TILE+1,ty*TILE+1,team);}}
function paintLine(g,x1,y1,x2,y2,team,radius=TILE*1.6){const d=Math.hypot(x2-x1,y2-y1),steps=Math.max(1,Math.ceil(d/(TILE*.3)));for(let i=0;i<=steps;i++)paintBrush(g,x1+(x2-x1)*i/steps,y1+(y2-y1)*i/steps,team,radius);}
function tileAt(g,x,y){const idx=cellIndex(x,y);return idx<0?0:g.territory[idx]||0;}
function nearestEnemy(g,p){let best=null,dist=Infinity;for(const q of g.players){if(q.team===p.team||!q.alive||q.shadow>=MAX_SHADOW-1e-6)continue;const d=Math.hypot(q.x-p.x,q.y-p.y);if(d<dist){dist=d;best=q;}}return best?{p:best,d:dist}:null;}
// 武器ごとの塗り幅と弾サイズは、ここで個別に調整できます（単位はワールド座標）。
// paintRadius：弾道の周囲を塗る半径。大きいほど太い塗り跡になります。
// bulletRadius：敵に当たる判定に使う弾の半径。大きいほど命中しやすくなります。
const WEAPONS = [
 {name:'標準ブラスター',range:1,interval:0.52,damage:27,cost:0.65,speed:180,charge:false,paintRadius:5,bulletRadius:4},
 {name:'ロングレンジ',range:2,interval:1.04,damage:32.4,cost:2,speed:180,charge:false,paintRadius:10,bulletRadius:7},
 {name:'チャージスナイパー',range:3,interval:0.25,damage:45,cost:0,speed:240,charge:true,maxCharge:1.5,chargeCostPerSec:4,paintRadius:15,bulletRadius:9}
];
function shoot(g,p,angle,charge=0){
 if(!p.alive||p.cooldown>0)return;
 const w=WEAPONS[p.weaponId]||WEAPONS[0];
 if(!w.charge&&p.shadow<w.cost)return;
 if(w.charge&&charge<0.25)return;
 p.angle=angle;
 if(!w.charge)p.shadow=Math.max(0,p.shadow-w.cost);
 p.cooldown=p.isCpu?(1.2+Math.random()*.25):w.interval;
 const power=w.charge?Math.max(0.55,Math.min(1,charge/(w.maxCharge||1.5))):1;
 const speed=w.speed,ox=p.x+Math.cos(angle)*(p.r+9),oy=p.y+Math.sin(angle)*(p.r+9);
 g.bullets.push({x:ox,y:oy,px:ox,py:oy,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed,team:p.team,ownerId:p.id,life:0.45*w.range,damage:w.damage*power,r:w.bulletRadius??(w.charge?9:8.5),paintRadius:w.paintRadius??TILE*1.6});
}
function kill(g,victim,killer){if(!victim.alive)return;victim.alive=false;victim.deaths++;victim.shadow=0;victim.respawn=1.7;if(killer&&killer.team!==victim.team){killer.kills++;g.scores[killer.team===BLUE?'blue':'red']++;g.events.push({text:`${killer.name} が ${victim.name} を倒した`,team:killer.team});}}
function spawn(p){p.alive=true;p.shadow=80;p.respawn=0;p.x=p.spawnX+(Math.random()-.5)*80;p.y=p.spawnY+(Math.random()-.5)*60;p.cooldown=.5;}
function aiStep(g,p,dt){if(!p.alive)return;const target=nearestEnemy(g,p);p.cooldown=Math.max(0,p.cooldown-dt);if(!target){ // No target is detectable: cautiously patrol toward mid-field without aiming at anyone.
  const midX=WORLD_W/2,midY=WORLD_H/2,dx=midX-p.x,dy=midY-p.y,d=Math.hypot(dx,dy)||1;p.x=clamp(p.x+dx/d*55*dt,p.r,WORLD_W-p.r);p.y=clamp(p.y+dy/d*55*dt,p.r,WORLD_H-p.r);return;
 }
 const q=target.p,dx=q.x-p.x,dy=q.y-p.y,d=target.d,a=Math.atan2(dy,dx);let tx=dx,ty=dy;
 if(d<420){tx=Math.cos(a+Math.PI/2*p.strafe)*.8+Math.cos(a)*(d>260?.4:-.28);ty=Math.sin(a+Math.PI/2*p.strafe)*.8+Math.sin(a)*(d>260?.4:-.28);if(Math.random()<.003)p.strafe*=-1;}
 const len=Math.hypot(tx,ty)||1;tx/=len;ty/=len;const speed=80+(p.shadow<30?8:0);p.x=clamp(p.x+tx*speed*dt,p.r,WORLD_W-p.r);p.y=clamp(p.y+ty*speed*dt,p.r,WORLD_H-p.r);p.angle=a;
 if(d<150&&p.cooldown<=0){const accuracy=(Math.random()-.5)*(.14+d*.00022);shoot(g,p,a+accuracy);}
}
function stepGame(room,dt){const g=room.game;if(!g||g.ended)return;g.tick++;g.timeLeft=Math.max(0,g.timeLeft-dt);g.events=[];g.paintChanges=[];
 for(const p of g.players){p.cooldown=Math.max(0,p.cooldown);if(!p.alive){p.respawn-=dt;if(p.respawn<=0)spawn(p);continue;}p.shadow=clamp(p.shadow+6.2*dt,0,MAX_SHADOW);const ground=tileAt(g,p.x,p.y);if(ground!==0&&ground!==p.team)p.shadow=clamp(p.shadow-10.8*dt,0,MAX_SHADOW);if(p.shadow<=0)kill(g,p,null);}
 for(const p of g.players){if(!p.alive)continue;if(p.isCpu){aiStep(g,p,dt);continue;}p.cooldown=Math.max(0,p.cooldown-dt);const i=p.input;let mx=clamp(i.moveX,-1,1),my=clamp(i.moveY,-1,1),len=Math.hypot(mx,my);if(len>1){mx/=len;my/=len;}const speed=95;p.x=clamp(p.x+mx*speed*dt,p.r,WORLD_W-p.r);p.y=clamp(p.y+my*speed*dt,p.r,WORLD_H-p.r);if(Number.isFinite(i.aim))p.angle=i.aim;
 const weapon=WEAPONS[p.weaponId]||WEAPONS[0];
 if(weapon.charge){
   if(i.fire){
     if(!p.wasFiring){p.chargeTime=0;p.pendingCharge=0;}
     const drain=Math.min(p.shadow,weapon.chargeCostPerSec*dt);
     p.shadow=Math.max(0,p.shadow-drain);
     p.chargeTime=Math.min(weapon.maxCharge,p.chargeTime+dt);
     if(p.shadow<=0)kill(g,p,null);
   }else if(p.wasFiring){
     if(p.chargeTime>=0.25)p.pendingCharge=p.chargeTime;
     p.chargeTime=0;
   }
   if(!i.fire&&p.pendingCharge>0&&p.cooldown<=0){
     const charge=p.pendingCharge;
     p.pendingCharge=0;
     shoot(g,p,p.angle,charge);
   }
   p.wasFiring=!!i.fire;
 }else{
   p.chargeTime=0;p.pendingCharge=0;p.wasFiring=false;
   if(i.fire)shoot(g,p,p.angle);
 }}
 for(let i=g.bullets.length-1;i>=0;i--){const b=g.bullets[i];b.px=b.x;b.py=b.y;b.x+=b.vx*dt;b.y+=b.vy*dt;b.life-=dt;paintLine(g,b.px,b.py,b.x,b.y,b.team,b.paintRadius);let hit=null;for(const p of g.players){if(!p.alive||p.team===b.team||p.id===b.ownerId)continue;if(Math.hypot(p.x-b.x,p.y-b.y)<p.r+b.r){hit=p;break;}}if(hit){hit.shadow=clamp(hit.shadow-b.damage,0,MAX_SHADOW);if(hit.shadow<=0)kill(g,hit,g.players.find(p=>p.id===b.ownerId));g.bullets.splice(i,1);continue;}if(b.life<=0||b.x<0||b.y<0||b.x>WORLD_W||b.y>WORLD_H)g.bullets.splice(i,1);}
 if(g.scores.blue>=20||g.scores.red>=20||g.timeLeft<=0){g.ended=true;g.winner=g.scores.blue===g.scores.red?'draw':g.scores.blue>g.scores.red?'blue':'red';room.status='finished';}
}
function snapshot(g){return {players:g.players.map(p=>({id:p.id,name:p.name,team:p.team,isCpu:p.isCpu,x:p.x,y:p.y,r:p.r,angle:p.angle,shadow:p.shadow,alive:p.alive,respawn:p.respawn,kills:p.kills,deaths:p.deaths,weaponId:p.weaponId,chargeTime:p.chargeTime})),bullets:g.bullets.map(b=>({x:b.x,y:b.y,px:b.px,py:b.py,r:b.r,team:b.team})),scores:g.scores,timeLeft:g.timeLeft,ended:g.ended,winner:g.winner||null,events:g.events};}
function leaveRoom(ws){const room=getClientRoom(ws);if(!room)return;const id=ws.session.id;room.clients.delete(id);ws.session.roomCode=null;if(room.status==='running'&&room.game){const p=room.game.players.find(p=>p.id===id);if(p){p.isCpu=true;p.name=`CPU (${p.name})`;p.input={moveX:0,moveY:0,aim:p.angle,fire:false};}}if(room.hostId===id){room.hostId=room.clients.keys().next().value||null;}if(room.clients.size===0){setTimeout(()=>{if(room.clients.size===0)rooms.delete(room.code);},30000);}else{sendRoom(room);}}
function onMessage(ws,data){let msg;try{msg=JSON.parse(data.toString());}catch{return send(ws,{type:'error',message:'送信内容を読み取れませんでした。'});}if(!msg||typeof msg.type!=='string')return;
 if(msg.type==='create'||msg.type==='join'){
  if (ws.session && ws.session.roomCode) leaveRoom(ws);
  let room;if(msg.type==='create'){room={code:newCode(),hostId:null,status:'lobby',clients:new Map(),game:null,gameMode:null};rooms.set(room.code,room);}else{const code=String(msg.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5);room=rooms.get(code);if(!room)return send(ws,{type:'error',message:'その部屋は見つかりません。部屋コードを確認してください。'});if(room.status!=='lobby')return send(ws,{type:'error',message:'その部屋はすでに試合中です。新しい部屋を作ってください。'});if(room.clients.size>=6)return send(ws,{type:'error',message:'その部屋は満員です。'});}
  const id=crypto.randomUUID();ws.session={id,name:cleanName(msg.name),roomCode:room.code};if(!room.hostId)room.hostId=id;room.clients.set(id,ws);send(ws,{type:'joined',id,code:room.code});sendRoom(room);return;
 }
 const room=getClientRoom(ws);if(!room)return;
 if(msg.type==='weaponChoice'&&room.status==='running'&&room.game){const p=room.game.players.find(p=>p.id===ws.session.id&&!p.isCpu);if(!p||p.alive)return;const id=Number(msg.weaponId);if(Number.isInteger(id)&&id>=0&&id<WEAPONS.length){p.weaponId=id;p.chargeTime=0;p.wasFiring=false;p.pendingCharge=0;p.input.fire=false;send(ws,{type:'weaponSelected',weaponId:id});}return;}
 if(msg.type==='input'&&room.status==='running'&&room.game){const p=room.game.players.find(p=>p.id===ws.session.id&&!p.isCpu);if(!p)return;p.input={moveX:clamp(Number(msg.moveX)||0,-1,1),moveY:clamp(Number(msg.moveY)||0,-1,1),aim:Number.isFinite(msg.aim)?msg.aim:p.angle,fire:!!msg.fire};return;}
 if(msg.type==='start'&&room.status==='lobby'){if(ws.session.id!==room.hostId)return send(ws,{type:'error',message:'試合を始められるのは部屋のホストです。'});startGame(room,!!msg.fillBots);return;}
 if(msg.type==='leave'){leaveRoom(ws);send(ws,{type:'left'});return;}
}
wss.on('connection',ws=>{ws.session=null;send(ws,{type:'connected'});ws.on('message',data=>onMessage(ws,data));ws.on('close',()=>leaveRoom(ws));ws.on('error',()=>leaveRoom(ws));});
setInterval(()=>{for(const room of rooms.values()){if(room.status!=='running'||!room.game||room.game.ended)continue;stepGame(room,1/30);if(room.game.paintChanges.length)broadcast(room,{type:'paint',cells:room.game.paintChanges});if(room.game.events.length)broadcast(room,{type:'events',events:room.game.events});if(room.game.ended){sendRoom(room);broadcast(room,{type:'state',state:snapshot(room.game)});continue;}broadcast(room,{type:'state',state:snapshot(room.game)});}},1000/30);
server.listen(PORT,'0.0.0.0',()=>console.log(`SHADOW POINT listening on 0.0.0.0:${PORT}`));
