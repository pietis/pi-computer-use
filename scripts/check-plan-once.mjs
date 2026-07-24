import assert from "node:assert/strict";
import { parsePlanOnceCommandArgs, parsePlanOnceJson, resolveAppTarget } from "../src/plan-once.ts";

const command = parsePlanOnceCommandArgs("--app TextEdit --bundle-id com.apple.TextEdit -- 새 문서에 테스트 입력");
assert.deepEqual(command, {
	app: "TextEdit",
	bundleId: "com.apple.TextEdit",
	task: "새 문서에 테스트 입력",
});

assert.deepEqual(parsePlanOnceCommandArgs("-- TextEdit에서 새 문서 만들기"), {
	app: "",
	bundleId: undefined,
	task: "TextEdit에서 새 문서 만들기",
});

const plan = parsePlanOnceJson(JSON.stringify({
	version: 1,
	phases: [
		{
			actions: [{ action: "keypress", selector: { role: "textArea" }, keys: ["cmd", "n"] }],
			refreshRootAfter: true,
		},
		{
			actions: [{ action: "setText", selector: { role: "textArea", capability: "setValue" }, text: "테스트" }],
			expect: { selector: { role: "textArea" }, value: "테스트" },
		},
	],
}));
assert.equal(plan.phases.length, 2);
assert.equal(plan.phases[1].expect?.value, "테스트");

assert.throws(
	() => parsePlanOnceJson('{"version":1,"phases":[{"actions":[{"action":"setText","selector":{"role":"textArea"},"text":"x"}]}]}'),
	/final plan phase/i,
);
assert.throws(
	() => parsePlanOnceCommandArgs("--app TextEdit missing-divider"),
	/Usage:/,
);

if (process.platform === "darwin") {
	const resolved = await resolveAppTarget({ app: "", task: 'TextEdit에서 "pi-computer-use 테스트"를 입력하기' });
	assert.equal(resolved.bundleId, "com.apple.TextEdit");
	assert.match(resolved.appPath ?? "", /TextEdit\.app$/);
	const notes = await resolveAppTarget({ app: "", task: "메모에서 새 메모 만들기" });
	assert.equal(notes.bundleId, "com.apple.Notes");
	const slack = await resolveAppTarget({ app: "", task: "Slack에서 채널 열기" });
	assert.match(slack.bundleId ?? "", /slack/i);
}

console.log("Plan-once parser checks passed.");
