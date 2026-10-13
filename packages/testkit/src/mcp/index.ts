/**
 * The MCP reference-client harness (Wave 7 order §33): a subpath of its
 * own, so that suites without MCP never load the client SDK.
 */
export {
  createProtocolClient,
  MODERN_REVISION,
  type ProtocolClient,
  type ProtocolClientOptions,
  type ProtocolEra,
} from './client.ts'
export {
  denormalize,
  type Exchange,
  firstDifference,
  messagesOf,
  Normalizer,
  parseTranscript,
  replayTranscript,
  TRANSCRIPT_FORMAT,
  type TranscriptHeader,
  TranscriptRecorder,
} from './transcript.ts'
