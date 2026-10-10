import { fileURLToPath } from 'node:url';

export const CORE_METHOD_SKILL_IDS = Object.freeze(['rna-delivery-quality', 'rna-skill-authoring', 'rna-tool-engineering', 'rna-learning-method', 'rna-media-production']);
export const coreMethodSkills = () => [
  ['rna-delivery-quality', '交付与质量验证', '制作或修改实际产品、界面、文档或数据时，建立质量标准，检查最终产物并修复缺陷。'],
  ['rna-skill-authoring', '专业技能设计', '编写或改进可复用技能时，设计触发条件、方法、示例、验收与错误恢复，避免空泛提示词。'],
  ['rna-tool-engineering', '工具与自动化设计', '创建脚本、工具或 MCP 适配时，定义契约、实际收益、失败语义和可执行验证。'],
  ['rna-learning-method', '实证学习与进化', '根据用户反馈或执行失败分析能力缺口，设计可证伪实验和独立验证，保留有效版本。'],
  ['rna-media-production', '多模态媒体制作', '生成或编辑图片、合成与识别语音、生成视频，并用 ffmpeg/ImageMagick/sips 在本地处理媒体文件。']
].map(([id, name, description]) => ({ id, name, description, path: fileURLToPath(new URL(`../skills/${id}/SKILL.md`, import.meta.url)), enabled: true, trusted: true, builtin: true, hostMethod: true }));
