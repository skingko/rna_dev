import { describe, expect, it } from 'vitest'
import { splitBlocks } from '@/components/markdown/Markdown'
import { visiblePrefix } from './MarkdownPreview'

describe('chunked Markdown preview', () => {
  it('keeps block boundaries when only the first chunk is shown', () => {
    const text = ['# 第三章 引灯', '检测中心在地下二层。', '"别看了，"年轻人推推眼镜。', '- 一\n- 二', '最后一段。'].join('\n\n')
    const blocks = splitBlocks(text)
    const prefix = visiblePrefix(text, blocks, 3)
    expect(prefix).toBe('# 第三章 引灯\n\n检测中心在地下二层。\n\n"别看了，"年轻人推推眼镜。')
    expect(splitBlocks(prefix)).toEqual(blocks.slice(0, 3).map(block => block.replace(/\n+$/, '')))
    expect(visiblePrefix(text, blocks, blocks.length)).toBe(text)
  })
})
