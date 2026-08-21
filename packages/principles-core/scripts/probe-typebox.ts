// 验证 TypeBox schema 序列化后的 JSON Schema 结构
import { Type } from "@sinclair/typebox";
import { PhilosopherOutputV1Schema } from "../src/runtime-v2/internalization/philosopher-output.ts";
import { ScribeOutputV1Schema } from "../src/runtime-v2/internalization/scribe-output.ts";

const s = JSON.parse(JSON.stringify(PhilosopherOutputV1Schema));
console.log("=== Philosopher ===");
console.log(JSON.stringify(s, null, 2));
console.log("\n=== Scribe sourceTrace (Optional 字段) ===");
const sc = JSON.parse(JSON.stringify(ScribeOutputV1Schema));
console.log(JSON.stringify(sc.properties.sourceTrace, null, 2));
