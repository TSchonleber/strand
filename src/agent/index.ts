/**
 * Public barrel for the agentic layer.
 *
 * Loops import from `@/agent` rather than reaching into internals. Keeps the
 * executor + loop runner discoverable as one unit.
 */

export {
  DockerExecutor,
  NoopExecutor,
} from "./executor";
export type {
  BashResult,
  ComputerExecutor,
  MouseButton,
  Screenshot,
  ScrollDirection,
  TextEditorCommand,
} from "./executor";
export { runAgenticLoop } from "./loop";
export type {
  LocalTool,
  LoopContext,
  LoopInput,
  LoopOutput,
  LoopStopReason,
  LoopTraceEntry,
} from "./loop";
