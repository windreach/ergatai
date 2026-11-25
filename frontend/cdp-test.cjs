const {chromium}=require('/home/yubing/code/ergatai/frontend/node_modules/@playwright/test');
(async()=>{
  const b=await chromium.connectOverCDP('http://127.0.0.1:9222');
  const c=b.contexts()[0];
  const p=c.pages().find(x=>!/devtools/i.test(x.url()));
  const client=await c.newCDPSession(p);
  let count=0; const start=Date.now();
  client.on('Page.screencastFrame', async (params)=>{
    count++;
    await client.send('Page.screencastFrameAck',{sessionId:params.sessionId});
    if (Date.now()-start > 5000) {
      console.log('frames in 5s:', count, 'fps:', (count/5).toFixed(1));
      await client.send('Page.stopScreencast');
      await b.close();
      process.exit(0);
    }
  });
  await client.send('Page.startScreencast', { format:'jpeg', quality:80, maxWidth:1280, maxHeight:720, everyNthFrame:1 });
})();
