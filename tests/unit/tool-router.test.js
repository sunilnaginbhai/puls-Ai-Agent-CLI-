import test from "node:test";
import assert from "node:assert/strict";
import { getLatestUserMessageText, getRoutingMessageText, selectToolsForMessage } from "../../src/agent/tool-router.js";

test("finds the latest human message even if a tool result follows it", () => {
    const text = getLatestUserMessageText([
        { type: "human", content: "Read src/main.js" },
        { type: "ai", content: "I will inspect it." },
        { type: "tool", content: "tool output" },
    ]);

    assert.equal(text, "Read src/main.js");
});

test("does not bind filesystem tools for a general question", () => {
    assert.deepEqual(selectToolsForMessage("What is a closure in JavaScript?"), []);
});

test("selects only the reader for a file-inspection request", () => {
    assert.deepEqual(selectToolsForMessage("Read src/main.js lines 10 to 20"), ["readFile"]);
});

test("selects only directory listing for a list request", () => {
    assert.deepEqual(selectToolsForMessage("List the files in src/tools"), ["listDirectory"]);
});

test("selects the scanner for an explicit project scan", () => {
    assert.deepEqual(selectToolsForMessage("Scan the project folders"), ["scanDirectory"]);
});

test("includes reading before modifying existing project code", () => {
    assert.deepEqual(
        selectToolsForMessage("Update the code in src/main.js to add a status command"),
        ["readFile", "applyFileOperations"]
    );
});

test("selects the batch mutation tool for an explicit file creation", () => {
    assert.deepEqual(
        selectToolsForMessage("Create src/new-file.js with a hello message"),
        ["applyFileOperations"]
    );
});

test("routes a Desktop create follow-up even with a directory typo", () => {
    assert.deepEqual(
        selectToolsForMessage("yes create in desktop directry"),
        ["applyFileOperations"]
    );
});

test("routes a website request that names an output file", () => {
    assert.deepEqual(
        selectToolsForMessage("Create a beautiful website in but.jtml file"),
        ["applyFileOperations"]
    );
});

test("supports a message that needs more than one distinct read-only tool", () => {
    assert.deepEqual(
        selectToolsForMessage("Scan the project and read src/main.js"),
        ["readFile", "scanDirectory"]
    );
});

test("routes fix and refactor requests as code changes", () => {
    assert.deepEqual(selectToolsForMessage("Fix the code in src/main.js"), ["readFile", "applyFileOperations"]);
    assert.deepEqual(selectToolsForMessage("Refactor the project module"), ["readFile", "applyFileOperations"]);
});

test("continues the preceding file task on an explicit short follow-up", () => {
    const routingText = getRoutingMessageText([
        { role: "user", content: "Read README and explain its setup" },
        { role: "assistant", content: "Should I inspect it?" },
        { role: "user", content: "Yes, go ahead" },
    ]);
    assert.deepEqual(selectToolsForMessage(routingText), ["readFile"]);
    assert.equal(getRoutingMessageText([{ role: "user", content: "What is a closure?" }]), "What is a closure?");
});
