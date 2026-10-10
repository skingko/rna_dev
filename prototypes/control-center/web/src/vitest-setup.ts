// Unit tests assert the zh-CN source strings; jsdom reports navigator.language 'en-US'.
import { usePreferences } from '@/components/settings/preferences'

usePreferences.setState({ language: 'zh' })
