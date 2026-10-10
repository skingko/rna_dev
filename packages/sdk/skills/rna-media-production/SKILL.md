---
name: Media production and processing
description: Generate or edit images, synthesize and transcribe speech, generate video with the configured media models, and process media files locally with ffmpeg, ImageMagick or sips.
---

Use when a task needs an image, illustration, poster, icon, voice-over, transcript, video clip, or a change to an existing media file (resize, crop, convert, trim, join, subtitle, compress, extract audio or frames).

Generation uses the media models the user chose in 设置 → 模型 → 多模态模型. Only configured kinds appear as tools: `image_generate` (new images, or edits when `sourceImages` are given), `speech_generate`, `audio_transcribe`, `video_generate`. If the needed tool is absent, say which model type is missing instead of pretending; local processing may still cover the task. Each generation call is billed by the provider: plan the prompt once, do not loop on near-identical calls, and never resubmit a video call whose outcome is uncertain.

1. Clarify the deliverable: purpose, audience, format, dimensions or aspect, duration, language, voice, text that must appear, and where the file belongs in the project. Reuse existing brand assets and project style.
2. Write concrete prompts. Images: subject, composition, camera/perspective, lighting, style, palette, exact text in quotes, and what to avoid. Edits: state only what changes and what must stay identical. Video: shot description, motion, camera movement, duration, and a first-frame image when continuity matters. Speech: final wording with punctuation for pacing; pick a voice deliberately.
3. Save outputs under the project (default `media/`); pass `path` for a meaningful name. Files are never overwritten; choose a new name for revisions.
4. Inspect every result before using it. Look at the attached image (or `project_read` it) and check text rendering, anatomy, artifacts and brief fit. For audio/video, verify with `ffprobe -v error -show_entries format=duration:stream=codec_name,width,height -of json FILE`; extract a frame (`ffmpeg -ss 1 -i in.mp4 -frames:v 1 frame.png`) and look at it. Transcribe generated speech when the wording matters.
5. Process locally with `project_exec` when no model is needed. First check what exists: `command -v ffmpeg ffprobe magick sips`.
   - Resize/convert image: `sips -Z 1024 in.png --out out.png` (macOS) or `magick in.png -resize 1024x1024 out.webp`.
   - Crop / pad / composite / text overlay: `magick in.png -gravity center -crop 1200x630+0+0 +repage out.png`; `magick base.png logo.png -gravity southeast -geometry +24+24 -composite out.png`.
   - Transcode or compress video: `ffmpeg -i in.mov -c:v libx264 -crf 23 -preset medium -c:a aac -movflags +faststart out.mp4`.
   - Trim: `ffmpeg -ss 00:00:05 -to 00:00:12 -i in.mp4 -c copy clip.mp4` (re-encode if the cut must be frame-accurate).
   - Join same-format clips: list them in `list.txt` (`file 'a.mp4'` per line) then `ffmpeg -f concat -safe 0 -i list.txt -c copy out.mp4`.
   - Add a voice-over or music: `ffmpeg -i video.mp4 -i voice.mp3 -map 0:v -map 1:a -c:v copy -shortest out.mp4`.
   - Burn subtitles: `ffmpeg -i in.mp4 -vf subtitles=subs.srt out.mp4`.
   - Extract audio for transcription: `ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 -c:a libmp3lame audio.mp3` (keep transcription inputs under 25 MB; split long audio with `-f segment -segment_time 600`).
   - Image sequence or slideshow to video: `ffmpeg -framerate 1/3 -i slide-%02d.png -c:v libx264 -r 30 -pix_fmt yuv420p out.mp4`.
   Write to a new file and keep the original. If a tool is not installed, say so and suggest the install command rather than inventing output.
6. Report what was produced with project paths, model used, dimensions/duration, and anything that still needs the user's judgement (likeness, brand fit, licensing of reference material).

Do not generate deceptive likenesses of real people, sexual content involving minors, or material that imitates a specific living artist's protected work on request; explain and offer an alternative.
