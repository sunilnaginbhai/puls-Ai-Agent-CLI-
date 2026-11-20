import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStartup } from '../../src/providers/onboarding.js';

function setup(answers) {
    const questions=[];
    let printed='';
    const input={isInteractive:true,question:async(prompt,options)=>{questions.push({prompt,options});return answers.shift();}};
    return {input,questions,output:{write(text){printed+=text;}},printed:()=>printed};
}
const missing=async()=>{throw new Error('API key not found');};

test('logged-out startup selects Gemini first and then asks for its hidden key',async()=>{
    const f=setup(['gemini','dummy-google-key']);
    let chosen;
    const result=await prepareStartup({...f,env:{},readSettings:async()=>({}),getKey:missing,
        ensureKey:async(prompt,{config})=>{chosen=config;return prompt(config);}});
    assert.equal(chosen.provider,'google');
    assert.equal(result.config.model,'gemini-2.5-flash');
    assert.match(f.questions[0].prompt,/Choose a provider/);
    assert.match(f.questions[1].prompt,/Google Gemini API key/);
    assert.equal(f.questions[1].options.secret,true);
    assert.doesNotMatch(f.printed(),/dummy-google-key/);
});

test('Groq selection and invalid-choice recovery ask for the matching key',async()=>{
    const f=setup(['invalid','1','dummy-groq-key']);
    const result=await prepareStartup({...f,env:{},readSettings:async()=>({}),getKey:missing,
        ensureKey:async(prompt,{config})=>prompt(config)});
    assert.equal(result.config.provider,'groq');
    assert.match(f.questions.at(-1).prompt,/Groq API key/);
    assert.match(f.printed(),/Choose Groq/);
});

test('OpenRouter onboarding offers free models and requests its provider key',async()=>{
    const f=setup(['4','dummy-openrouter-key']);
    let chosen;
    const result=await prepareStartup({...f,env:{},readSettings:async()=>({}),getKey:missing,
        ensureKey:async(prompt,{config})=>{chosen=config;return prompt(config);}});
    assert.equal(chosen.provider,'openrouter');
    assert.equal(result.config.model,'openrouter/free');
    assert.match(f.printed(),/OpenRouter \(free models available\)/);
    assert.match(f.questions[0].prompt,/Choose a provider \[1-5 or name\]/);
    assert.match(f.questions[1].prompt,/OpenRouter API key/);
    assert.equal(f.questions[1].options.secret,true);
    assert.doesNotMatch(f.printed(),/dummy-openrouter-key/);
});

test('FreeLLMAPI onboarding selects the router and requests its hidden key',async()=>{
    const f=setup(['5','dummy-freellmapi-key']);
    let chosen;
    const result=await prepareStartup({...f,env:{},readSettings:async()=>({}),getKey:missing,
        ensureKey:async(prompt,{config})=>{chosen=config;return prompt(config);}});
    assert.equal(chosen.provider,'freellmapi');
    assert.equal(result.config.model,'auto');
    assert.match(f.printed(),/FreeLLMAPI \(free model router\)/);
    assert.match(f.questions[0].prompt,/Choose a provider \[1-5 or name\]/);
    assert.match(f.questions[1].prompt,/FreeLLMAPI API key/);
    assert.equal(f.questions[1].options.secret,true);
    assert.doesNotMatch(f.printed(),/dummy-freellmapi-key/);
});

test('saved provider is restored without prompting when its key exists',async()=>{
    const f=setup([]);
    const result=await prepareStartup({...f,env:{},readSettings:async()=>({activeProvider:'google'}),getKey:async({config})=>{
        assert.equal(config.provider,'google');return 'dummy-saved-key';
    },ensureKey:async()=>{throw new Error('Must not prompt');}});
    assert.equal(result.config.provider,'google');
    assert.equal(f.questions.length,0);
});

test('explicit provider configuration takes precedence over saved selection',async()=>{
    const f=setup([]);
    const result=await prepareStartup({...f,env:{PULS_PROVIDER:'openai'},readSettings:async()=>({activeProvider:'google'}),getKey:async()=> 'dummy'});
    assert.equal(result.config.provider,'openai');
    assert.equal(f.questions.length,0);
});

test('cancelling provider selection never asks for or saves a key',async()=>{
    const f=setup([]);
    f.input.question=async()=>{throw Object.assign(new Error('Cancelled'),{code:'INPUT_CANCELLED'});};
    await assert.rejects(prepareStartup({...f,env:{},readSettings:async()=>({}),getKey:missing,
        ensureKey:async()=>{throw new Error('Must not request a key');}}),{code:'INPUT_CANCELLED'});
});
