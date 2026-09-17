const express=require('express');

// Central authorization policy. This layer only tightens existing routes; it never grants access
// that the underlying application would otherwise deny.
const DIRECTOR='DIRECTOR', MD='MANAGING_DIRECTOR', ACCOUNTANT='ACCOUNTANT';
const executiveRoles=new Set([DIRECTOR,MD]);
const financeRoles=new Set([DIRECTOR,MD,ACCOUNTANT]);

function policy(method,path){
  const p=String(path||''); const m=String(method||'').toUpperCase();
  // Director-only governance, identity, pricing approval, activation and irreversible controls.
  if(/^\/api\/users(?:\/|$)/.test(p)||/^\/api\/administration(?:\/|$)/.test(p)||/^\/api\/settings(?:\/|$)/.test(p)||/^\/api\/stock\/opening(?:\/|$)/.test(p)||/^\/api\/accounting\/accountants(?:\/|$)/.test(p)) return new Set([DIRECTOR]);
  if(/^\/api\/products(?:\/|$)/.test(p)&&m!=='GET') return new Set([DIRECTOR]);
  if(/^\/api\/accounting\/pricing\//.test(p)&&m!=='GET') return new Set([DIRECTOR]);
  if(/^\/api\/payments\/config$/.test(p)&&m==='PUT') return new Set([DIRECTOR]);
  if(/^\/api\/purchase-orders\/[^/]+\/approve$/.test(p)||/^\/api\/stock-counts\/[^/]+\/close$/.test(p)) return new Set([DIRECTOR]);

  // Executive management: commercially sensitive and business-control functions.
  if(/^\/api\/(billing|merchant-settlements|suppliers|purchase-orders|reports|alerts|audit|cashups|expenses)(?:\/|$)/.test(p)) return executiveRoles;
  if(/^\/api\/sales\/recent$/.test(p)||(/^\/api\/sales\/[^/]+\/void$/.test(p))) return executiveRoles;
  if(/^\/api\/payments\/(config|readiness)$/.test(p)) return executiveRoles;

  // Finance is Director / Managing Director / Accountant only.
  if(/^\/api\/accounting(?:\/|$)/.test(p)) return financeRoles;
  return null;
}

function guard(allowed){return function(req,res,next){if(!req.user)return res.status(401).json({error:'Authentication required'});if(!allowed.has(req.user.role))return res.status(403).json({error:'This control is restricted to authorised executive management'});next();}}

for(const method of ['get','post','put','patch','delete']){
  const prior=express.application[method];
  express.application[method]=function(path,...handlers){
    const allowed=policy(method,path);
    if(!allowed||handlers.length===0)return prior.call(this,path,...handlers);
    // Existing routes normally begin with auth and sometimes another role middleware.
    // Insert our stricter guard immediately before the business handler.
    const idx=Math.max(0,handlers.length-1);
    handlers.splice(idx,0,guard(allowed));
    return prior.call(this,path,...handlers);
  };
}
