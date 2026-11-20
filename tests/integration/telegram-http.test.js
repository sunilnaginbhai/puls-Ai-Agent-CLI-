import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AIMessage } from '@langchain/core/messages';
import { TelegramClient } from '../../src/integrations/telegram/client.js';
import { TelegramRuntime } from '../../src/integrations/telegram/runtime.js';
import { createAgentGraph } from '../../src/agent/agent.graph.js';

test('actual HTTP Telegram transport delivers an authorized message through the shared graph',async()=>{
    const replies=[];
    const server=http.createServer(async(req,res)=>{
        let raw='';for await(const chunk of req)raw+=chunk;
        const body=JSON.parse(raw), method=req.url.split('/').at(-1);
        let result;
        if(method==='getMe')result={id:123,is_bot:true,username:'offline_bot'};
        else if(method==='getUpdates')result=[{update_id:1,message:{text:'Explain closures',from:{id:11},chat:{id:11,type:'private'}}}];
        else if(method==='sendMessage'){replies.push(body);result={message_id:1};}
        res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,result}));
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    try{
        const client=new TelegramClient('123:dummy_local_telegram_test_token',{baseUrl:`http://127.0.0.1:${server.address().port}`});
        assert.equal((await client.call('getMe')).is_bot,true);
        const runtime=new TelegramRuntime({client,allowedUserIds:['11'],providerConfig:{model:'offline-test'},prepareModel:async()=> 'dummy-key',
            graphFactory:()=>createAgentGraph({tools:[],modelNode:async()=>({messages:[new AIMessage('A closure remembers its surrounding variables.')]})})});
        const updates=await client.call('getUpdates',{timeout:0});
        await runtime.handle(updates[0]);
        assert.equal(replies.length,1);assert.equal(replies[0].chat_id,11);
        assert.match(replies[0].text,/closure remembers/);
        await runtime.stop();
    }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
