import type { ChatTargetContext } from '../../types/chat'

export function deriveChatTargetFromPath(path?: string | null): ChatTargetContext | null {
  if (!path) {
    return {
      type: 'project',
      displayName: '当前项目',
      derivedFrom: 'selection',
    }
  }

  if (path.startsWith('chapters/')) {
    return {
      type: 'chapter',
      primaryPath: path,
      groupName: 'chapters',
      displayName: basename(path),
      derivedFrom: 'preview',
    }
  }

  if (path === 'prompts/system.md') {
    return {
      type: 'prompt-system',
      primaryPath: path,
      groupName: 'prompts',
      displayName: 'system prompt',
      derivedFrom: 'preview',
    }
  }

  if (path.startsWith('prompts/scenes/')) {
    return {
      type: 'prompt-scene',
      primaryPath: path,
      groupName: 'prompts',
      displayName: basename(path),
      derivedFrom: 'preview',
    }
  }

  if (path.startsWith('elements/')) {
    return {
      type: 'element',
      primaryPath: path,
      groupName: 'elements',
      displayName: basename(path),
      derivedFrom: 'preview',
    }
  }

  return {
    type: 'project',
    primaryPath: path,
    displayName: basename(path),
    derivedFrom: 'preview',
  }
}

function basename(path: string) {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}
