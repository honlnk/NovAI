import {
  createFileTool,
  deleteFileTool,
  editFileTool,
  readFileTool,
  renameFileTool,
} from './file-tools'
import { findFilesTool, listDirectoryTool } from './directory-tools'
import { searchFilesTool } from './search-text'
import { ragSearchTool } from './rag-search'
import { loadElementsTool } from './load-elements'
import {
  createPlanTool,
  deletePlanTool,
  listPlansTool,
  readPlanTool,
  updatePlanTool,
} from './plan-tools'
import {
  createForeshadowingTool,
  deleteForeshadowingTool,
  foreshadowingCheckTool,
  foreshadowingSyncTool,
  listForeshadowingTool,
  readForeshadowingForPlanningTool,
  readForeshadowingTool,
  updateForeshadowingTool,
} from './foreshadowing-tools'
import {
  rhythmCheckTool,
  rhythmCreateTool,
  rhythmCurveTool,
  rhythmDeleteTool,
  rhythmListTool,
  rhythmReadTool,
  rhythmSyncTool,
  rhythmUpdateTool,
} from './rhythm-tools'
import {
  relationCheckTool,
  relationCreateTool,
  relationDeleteTool,
  relationListTool,
  relationQueryTool,
  relationReadTool,
  relationUpdateTool,
} from './relation-tools'
import {
  timelineCreatePointTool,
  timelineCreateSpanTool,
  timelineDeleteTool,
  timelineListTool,
  timelineReadTool,
  timelineUpdateTool,
} from './timeline-tools'
import { getFileChangeHistoryTool } from './change-history-tool'
import { webSearchTool } from './web-search'
import { webFetchTool } from './web-fetch'
import { knowledgeLookupTool } from './knowledge-lookup'
import type {
  CoreToolName,
  CreateFileInput,
  CreateFileOutput,
  DeleteFileInput,
  DeleteFileOutput,
  EditFileInput,
  EditFileOutput,
  FindFilesInput,
  FindFilesOutput,
  SearchFilesInput,
  SearchFilesOutput,
  GetFileChangeHistoryInput,
  GetFileChangeHistoryOutput,
  KnowledgeLookupInput,
  KnowledgeLookupOutput,
  ListDirectoryInput,
  ListDirectoryOutput,
  LoadElementsInput,
  LoadElementsOutput,
  LoadedElement,
  ListPlansInput,
  ListPlansOutput,
  ReadPlanInput,
  ReadPlanOutput,
  CreatePlanInput,
  CreatePlanOutput,
  UpdatePlanInput,
  UpdatePlanOutput,
  DeletePlanInput,
  DeletePlanOutput,
  ListForeshadowingInput,
  ListForeshadowingOutput,
  ReadForeshadowingInput,
  ReadForeshadowingOutput,
  ReadForeshadowingForPlanningOutput,
  CreateForeshadowingInput,
  CreateForeshadowingOutput,
  UpdateForeshadowingInput,
  UpdateForeshadowingOutput,
  DeleteForeshadowingInput,
  DeleteForeshadowingOutput,
  ForeshadowingCheckInput,
  ForeshadowingCheckOutput,
  ForeshadowingSyncInput,
  ForeshadowingSyncOutput,
  RhythmListInput,
  RhythmListOutput,
  RhythmReadInput,
  RhythmReadOutput,
  RhythmCreateInput,
  RhythmCreateOutput,
  RhythmUpdateInput,
  RhythmUpdateOutput,
  RhythmDeleteInput,
  RhythmDeleteOutput,
  RhythmCheckInput,
  RhythmCheckOutput,
  RhythmSyncInput,
  RhythmSyncOutput,
  RhythmCurveInput,
  RhythmCurveOutput,
  RelationListInput,
  RelationListOutput,
  RelationReadInput,
  RelationReadOutput,
  RelationCreateInput,
  RelationCreateOutput,
  RelationUpdateInput,
  RelationUpdateOutput,
  RelationDeleteInput,
  RelationDeleteOutput,
  RelationQueryInput,
  RelationQueryOutput,
  RelationCheckInput,
  RelationCheckOutput,
  TimelineListInput,
  TimelineListOutput,
  TimelineReadInput,
  TimelineReadOutput,
  TimelineCreatePointInput,
  TimelineCreateSpanInput,
  TimelineCreateOutput,
  TimelineUpdateInput,
  TimelineUpdateOutput,
  TimelineDeleteInput,
  TimelineDeleteOutput,
  ReadFileInput,
  ReadFileOutput,
  ReadFileState,
  RagSearchInput,
  RagSearchOutput,
  RenameFileInput,
  RenameFileOutput,
  ToolCall,
  ToolDefinition,
  ToolExecution,
  ToolResult,
  ToolRuntime,
  WebFetchInput,
  WebFetchOutput,
  WebSearchInput,
  WebSearchOutput,
} from './types'

export type {
  CoreToolName,
  CreateFileInput,
  CreateFileOutput,
  DeleteFileInput,
  DeleteFileOutput,
  EditFileInput,
  EditFileOutput,
  FindFilesInput,
  FindFilesOutput,
  SearchFilesInput,
  SearchFilesOutput,
  GetFileChangeHistoryInput,
  GetFileChangeHistoryOutput,
  KnowledgeLookupInput,
  KnowledgeLookupOutput,
  ListDirectoryInput,
  ListDirectoryOutput,
  LoadElementsInput,
  LoadElementsOutput,
  LoadedElement,
  ListPlansInput,
  ListPlansOutput,
  ReadPlanInput,
  ReadPlanOutput,
  CreatePlanInput,
  CreatePlanOutput,
  UpdatePlanInput,
  UpdatePlanOutput,
  DeletePlanInput,
  DeletePlanOutput,
  ListForeshadowingInput,
  ListForeshadowingOutput,
  ReadForeshadowingInput,
  ReadForeshadowingOutput,
  ReadForeshadowingForPlanningOutput,
  CreateForeshadowingInput,
  CreateForeshadowingOutput,
  UpdateForeshadowingInput,
  UpdateForeshadowingOutput,
  DeleteForeshadowingInput,
  DeleteForeshadowingOutput,
  ForeshadowingCheckInput,
  ForeshadowingCheckOutput,
  ForeshadowingSyncInput,
  ForeshadowingSyncOutput,
  RhythmListInput,
  RhythmListOutput,
  RhythmReadInput,
  RhythmReadOutput,
  RhythmCreateInput,
  RhythmCreateOutput,
  RhythmUpdateInput,
  RhythmUpdateOutput,
  RhythmDeleteInput,
  RhythmDeleteOutput,
  RhythmCheckInput,
  RhythmCheckOutput,
  RhythmSyncInput,
  RhythmSyncOutput,
  RhythmCurveInput,
  RhythmCurveOutput,
  RelationListInput,
  RelationListOutput,
  RelationReadInput,
  RelationReadOutput,
  RelationCreateInput,
  RelationCreateOutput,
  RelationUpdateInput,
  RelationUpdateOutput,
  RelationDeleteInput,
  RelationDeleteOutput,
  RelationQueryInput,
  RelationQueryOutput,
  RelationCheckInput,
  RelationCheckOutput,
  TimelineListInput,
  TimelineListOutput,
  TimelineReadInput,
  TimelineReadOutput,
  TimelineCreatePointInput,
  TimelineCreateSpanInput,
  TimelineCreateOutput,
  TimelineUpdateInput,
  TimelineUpdateOutput,
  TimelineDeleteInput,
  TimelineDeleteOutput,
  ReadFileInput,
  ReadFileOutput,
  ReadFileState,
  RagSearchInput,
  RagSearchOutput,
  RenameFileInput,
  RenameFileOutput,
  ToolCall,
  ToolExecution,
  ToolResult,
  ToolRuntime,
  WebFetchInput,
  WebFetchOutput,
  WebSearchInput,
  WebSearchOutput,
}

type ToolOutputMap = {
  ReadFile: ReadFileOutput
  EditFile: EditFileOutput
  CreateFile: CreateFileOutput
  RenameFile: RenameFileOutput
  DeleteFile: DeleteFileOutput
  ListDirectory: ListDirectoryOutput
  FindFiles: FindFilesOutput
  SearchFiles: SearchFilesOutput
  RagSearch: RagSearchOutput
  LoadElements: LoadElementsOutput
  ListPlans: ListPlansOutput
  ReadPlan: ReadPlanOutput
  CreatePlan: CreatePlanOutput
  UpdatePlan: UpdatePlanOutput
  DeletePlan: DeletePlanOutput
  ListForeshadowing: ListForeshadowingOutput
  ReadForeshadowing: ReadForeshadowingOutput
  ReadForeshadowingForPlanning: ReadForeshadowingForPlanningOutput
  CreateForeshadowing: CreateForeshadowingOutput
  UpdateForeshadowing: UpdateForeshadowingOutput
  DeleteForeshadowing: DeleteForeshadowingOutput
  ForeshadowingCheck: ForeshadowingCheckOutput
  ForeshadowingSync: ForeshadowingSyncOutput
  RhythmList: RhythmListOutput
  RhythmRead: RhythmReadOutput
  RhythmCreate: RhythmCreateOutput
  RhythmUpdate: RhythmUpdateOutput
  RhythmDelete: RhythmDeleteOutput
  RhythmCheck: RhythmCheckOutput
  RhythmSync: RhythmSyncOutput
  RhythmCurve: RhythmCurveOutput
  RelationList: RelationListOutput
  RelationRead: RelationReadOutput
  RelationCreate: RelationCreateOutput
  RelationUpdate: RelationUpdateOutput
  RelationDelete: RelationDeleteOutput
  RelationQuery: RelationQueryOutput
  RelationCheck: RelationCheckOutput
  TimelineList: TimelineListOutput
  TimelineRead: TimelineReadOutput
  TimelineCreatePoint: TimelineCreateOutput
  TimelineCreateSpan: TimelineCreateOutput
  TimelineUpdate: TimelineUpdateOutput
  TimelineDelete: TimelineDeleteOutput
  GetFileChangeHistory: GetFileChangeHistoryOutput
  WebSearch: WebSearchOutput
  WebFetch: WebFetchOutput
  KnowledgeLookup: KnowledgeLookupOutput
}

const tools = {
  ReadFile: readFileTool,
  EditFile: editFileTool,
  CreateFile: createFileTool,
  RenameFile: renameFileTool,
  DeleteFile: deleteFileTool,
  ListDirectory: listDirectoryTool,
  FindFiles: findFilesTool,
  SearchFiles: searchFilesTool,
  RagSearch: ragSearchTool,
  LoadElements: loadElementsTool,
  ListPlans: listPlansTool,
  ReadPlan: readPlanTool,
  CreatePlan: createPlanTool,
  UpdatePlan: updatePlanTool,
  DeletePlan: deletePlanTool,
  ListForeshadowing: listForeshadowingTool,
  ReadForeshadowing: readForeshadowingTool,
  ReadForeshadowingForPlanning: readForeshadowingForPlanningTool,
  CreateForeshadowing: createForeshadowingTool,
  UpdateForeshadowing: updateForeshadowingTool,
  DeleteForeshadowing: deleteForeshadowingTool,
  ForeshadowingCheck: foreshadowingCheckTool,
  ForeshadowingSync: foreshadowingSyncTool,
  RhythmList: rhythmListTool,
  RhythmRead: rhythmReadTool,
  RhythmCreate: rhythmCreateTool,
  RhythmUpdate: rhythmUpdateTool,
  RhythmDelete: rhythmDeleteTool,
  RhythmCheck: rhythmCheckTool,
  RhythmSync: rhythmSyncTool,
  RhythmCurve: rhythmCurveTool,
  RelationList: relationListTool,
  RelationRead: relationReadTool,
  RelationCreate: relationCreateTool,
  RelationUpdate: relationUpdateTool,
  RelationDelete: relationDeleteTool,
  RelationQuery: relationQueryTool,
  RelationCheck: relationCheckTool,
  TimelineList: timelineListTool,
  TimelineRead: timelineReadTool,
  TimelineCreatePoint: timelineCreatePointTool,
  TimelineCreateSpan: timelineCreateSpanTool,
  TimelineUpdate: timelineUpdateTool,
  TimelineDelete: timelineDeleteTool,
  GetFileChangeHistory: getFileChangeHistoryTool,
  WebSearch: webSearchTool,
  WebFetch: webFetchTool,
  KnowledgeLookup: knowledgeLookupTool,
} satisfies Record<CoreToolName, ToolDefinition<CoreToolName, unknown, unknown>>

export function getCoreTools() {
  return tools
}

export function getCoreTool(name: CoreToolName) {
  return tools[name]
}

export async function executeCoreTool<TName extends CoreToolName>(
  name: TName,
  input: unknown,
  runtime: ToolRuntime,
): Promise<ToolExecution<TName, unknown, ToolOutputMap[TName]>> {
  const tool = tools[name] as ToolDefinition<TName, unknown, ToolOutputMap[TName]>
  const call: ToolCall<TName, unknown> = {
    id: createToolCallId(),
    name,
    input,
    createdAt: new Date().toISOString(),
  }

  try {
    const validatedInput = tool.validateInput(input)
    const output = await tool.run(validatedInput, runtime)

    return {
      call,
      result: {
        callId: call.id,
        name,
        ok: true,
        output,
        summary: tool.summarizeOutput(output),
        createdAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : `${name} 执行失败`

    return {
      call,
      result: {
        callId: call.id,
        name,
        ok: false,
        error: message,
        summary: message,
        createdAt: new Date().toISOString(),
      },
    }
  }
}

function createToolCallId() {
  return `tool-${Math.random().toString(36).slice(2, 10)}`
}
