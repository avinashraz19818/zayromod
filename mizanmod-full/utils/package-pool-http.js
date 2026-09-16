'use strict';
const {createPool}=require('./package-pool');
module.exports=function register(app,db,requireAdmin){
  const pool=createPool(db);
  app.get('/api/admin/packages',requireAdmin,(req,res)=>res.json({...pool.stats(),items:pool.list(req.query.state,req.query.offset),admin_ids:pool.admins()}));
  app.post('/api/admin/packages',requireAdmin,(req,res)=>{
    try{res.json(pool.add(req.body.packages,'web-admin'));}catch(e){res.status(400).json({error:e.message});}
  });
  app.post('/api/admin/packages/admins',requireAdmin,(req,res)=>{
    try{res.json({admin_ids:pool.setAdmins(req.body.ids)});}catch(e){res.status(400).json({error:e.message});}
  });
  app.delete('/api/admin/packages/:id',requireAdmin,(req,res)=>{
    try{if(!/^\d+$/.test(req.params.id))throw Error('Invalid package ID');res.json(pool.remove(req.params.id));}catch(e){res.status(409).json({error:e.message});}
  });
};
