package upload

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// TimelineSegment 描述时间线中的一个视频片段。
// Start/End 为源视频中的秒数；End 不大于 Start 时使用整段素材。
type TimelineSegment struct {
	FileID string
	Start  float64
	End    float64
}

// TimelineAudioSegment 描述独立音频轨上的片段。
// TimelineStart 为片段在时间线上的起点（秒）；nil 表示紧接着上一个音频片段。
type TimelineAudioSegment struct {
	FileID        string
	Start         float64
	End           float64
	TimelineStart *float64
}

// ConcatTimelineInput 描述一次时间线拼接请求。
type ConcatTimelineInput struct {
	UserID        uint
	Segments      []TimelineSegment
	AudioSegments []TimelineAudioSegment
}

const (
	timelineMaxSegments    = 20
	timelineMaxOutputBytes = 2 * 1024 * 1024 * 1024
)

// timelineFilterTarget 统一输出规格：不同来源的分辨率、帧率与音频参数必须一致才能 concat。
const (
	timelineWidth  = 1280
	timelineHeight = 720
	timelineFPS    = 30
)

// ConcatTimeline 按顺序裁剪并拼接多个视频片段，输出新的平台视频文件。
// 依赖运行环境中的 ffmpeg（可用配置项 FFmpegPath 或环境变量 FFMPEG_PATH 指定路径）。
func (s *Service) ConcatTimeline(ctx context.Context, input ConcatTimelineInput) (*UploadFileResult, error) {
	if s == nil {
		return nil, fmt.Errorf("upload service not configured")
	}
	if len(input.Segments) == 0 {
		return nil, fmt.Errorf("timeline requires at least one segment")
	}
	if len(input.Segments) > timelineMaxSegments {
		return nil, fmt.Errorf("timeline supports at most %d segments", timelineMaxSegments)
	}

	ffmpeg := strings.TrimSpace(s.snapshot().FFmpegPath)
	if ffmpeg == "" {
		ffmpeg = "ffmpeg"
	}
	if _, err := exec.LookPath(ffmpeg); err != nil {
		return nil, fmt.Errorf("ffmpeg not available: %w", err)
	}
	// ffprobe 用于探测每个源文件是否带音轨；无音轨时补静音轨，避免 concat 失败
	ffprobe := "ffprobe"
	if filepath.Base(ffmpeg) != "ffmpeg" {
		ffprobe = filepath.Join(filepath.Dir(ffmpeg), "ffprobe")
	}
	if _, err := exec.LookPath(ffprobe); err != nil {
		ffprobe = "ffprobe"
		if _, probeErr := exec.LookPath(ffprobe); probeErr != nil {
			return nil, fmt.Errorf("ffprobe not available: %w", probeErr)
		}
	}

	workDir, err := os.MkdirTemp("", "deeix-timeline-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(workDir)

	// 把每个源文件落到本地临时文件，供 ffmpeg 读取，并探测音轨与时长
	type timelineInput struct {
		path     string
		hasAudio bool
		duration float64
	}
	inputs := make([]timelineInput, 0, len(input.Segments))
	for index, segment := range input.Segments {
		fileID := strings.TrimSpace(segment.FileID)
		if fileID == "" {
			return nil, fmt.Errorf("timeline segment %d has no file", index+1)
		}
		content, err := s.OpenFileContent(ctx, input.UserID, fileID)
		if err != nil {
			return nil, fmt.Errorf("timeline segment %d: %w", index+1, err)
		}
		path := filepath.Join(workDir, fmt.Sprintf("in-%02d", index))
		target, err := os.Create(path)
		if err != nil {
			_ = content.Reader.Close()
			return nil, err
		}
		_, copyErr := io.Copy(target, content.Reader)
		_ = target.Close()
		_ = content.Reader.Close()
		if copyErr != nil {
			return nil, copyErr
		}
		inputs = append(inputs, timelineInput{
			path:     path,
			hasAudio: probeHasAudio(ctx, ffprobe, path),
			duration: probeDuration(ctx, ffprobe, path),
		})
	}

	// 视频轨总时长：用于把独立音频轨补齐/裁到与成片等长
	totalVideoDuration := 0.0
	for index, segment := range input.Segments {
		duration := inputs[index].duration
		start := 0.0
		end := duration
		if segment.End > segment.Start {
			start, end = segment.Start, segment.End
		}
		if duration > 0 && end > duration {
			end = duration
		}
		if end > start {
			totalVideoDuration += end - start
		}
	}

	// 独立音频轨片段：落到临时文件并探测时长，供混音使用
	type timelineAudio struct {
		path  string
		start float64
		end   float64
		delay float64
	}
	audios := make([]timelineAudio, 0, len(input.AudioSegments))
	audioCursor := 0.0
	for index, segment := range input.AudioSegments {
		fileID := strings.TrimSpace(segment.FileID)
		if fileID == "" {
			continue
		}
		content, err := s.OpenFileContent(ctx, input.UserID, fileID)
		if err != nil {
			return nil, fmt.Errorf("timeline audio segment %d: %w", index+1, err)
		}
		path := filepath.Join(workDir, fmt.Sprintf("audio-%02d", index))
		target, err := os.Create(path)
		if err != nil {
			_ = content.Reader.Close()
			return nil, err
		}
		_, copyErr := io.Copy(target, content.Reader)
		_ = target.Close()
		_ = content.Reader.Close()
		if copyErr != nil {
			return nil, copyErr
		}
		if !probeHasAudio(ctx, ffprobe, path) {
			continue
		}
		duration := probeDuration(ctx, ffprobe, path)
		start := 0.0
		end := duration
		if segment.End > segment.Start {
			start, end = segment.Start, segment.End
		}
		if duration > 0 && end > duration {
			end = duration
		}
		trimmed := end - start
		if trimmed <= 0 {
			trimmed = duration
		}
		delay := audioCursor
		if segment.TimelineStart != nil {
			delay = math.Max(0, *segment.TimelineStart)
		}
		audioCursor = delay + math.Max(0, trimmed)
		audios = append(audios, timelineAudio{path: path, start: start, end: end, delay: delay})
	}
	// 有独立音频轨时以它为最终音轨，视频自带声音不再参与合成
	useAudioTrack := len(audios) > 0

	// 单次 ffmpeg 调用：逐段统一规格并裁剪，再用 concat 滤镜按顺序拼接。
	args := []string{"-y", "-hide_banner", "-loglevel", "error"}
	for _, item := range inputs {
		args = append(args, "-i", item.path)
	}
	audioInputIndex := make([]int, len(inputs))
	silentIndex := len(inputs)
	if !useAudioTrack {
		// 无独立音频轨时：无音轨的视频追加 anullsrc 静音输入，保证每段都有音频流可参与 concat
		for index, item := range inputs {
			if item.hasAudio {
				audioInputIndex[index] = index
				continue
			}
			duration := item.duration
			if duration <= 0 {
				duration = 30
			}
			args = append(args,
				"-f", "lavfi",
				"-t", formatSeconds(duration),
				"-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
			)
			audioInputIndex[index] = silentIndex
			silentIndex++
		}
	}
	for _, audio := range audios {
		args = append(args, "-i", audio.path)
	}
	audioBaseIndex := silentIndex

	filters := make([]string, 0, len(input.Segments)*2+len(audios)+2)
	concatInputs := make([]string, 0, len(input.Segments))
	for index, segment := range input.Segments {
		filters = append(filters, fmt.Sprintf(
			"[%d:v]scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=%d%s,setpts=PTS-STARTPTS[v%d]",
			index, timelineWidth, timelineHeight, timelineWidth, timelineHeight, timelineFPS,
			timelineTrimArgs(segment, "trim"), index,
		))
		concatInputs = append(concatInputs, fmt.Sprintf("[v%d]", index))
	}
	if useAudioTrack {
		// 只拼接画面，音轨由独立音频轨混音得到
		filters = append(filters, fmt.Sprintf(
			"%sconcat=n=%d:v=1:a=0[vout]",
			strings.Join(concatInputs, ""), len(input.Segments),
		))
		audioLabels := make([]string, 0, len(audios))
		for index, audio := range audios {
			trim := ""
			if audio.end > audio.start {
				trim = fmt.Sprintf("atrim=start=%s:end=%s,", formatSeconds(audio.start), formatSeconds(audio.end))
			}
			delayMs := int64(math.Round(math.Max(0, audio.delay) * 1000))
			filters = append(filters, fmt.Sprintf(
				"[%d:a]%sasetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo,adelay=%d|%d[a%d]",
				audioBaseIndex+index, trim, delayMs, delayMs, index,
			))
			audioLabels = append(audioLabels, fmt.Sprintf("[a%d]", index))
		}
		audioChain := strings.Join(audioLabels, "")
		if len(audios) > 1 {
			audioChain = fmt.Sprintf("%samix=inputs=%d:duration=longest:normalize=0,", audioChain, len(audios))
		}
		if totalVideoDuration > 0 {
			audioChain += fmt.Sprintf("apad,atrim=0:%s,asetpts=PTS-STARTPTS", formatSeconds(totalVideoDuration))
		}
		filters = append(filters, fmt.Sprintf("%s[aout]", audioChain))
	} else {
		for index, segment := range input.Segments {
			filters = append(filters, fmt.Sprintf(
				"[%d:a]aresample=44100,aformat=channel_layouts=stereo%s,asetpts=PTS-STARTPTS[a%d]",
				audioInputIndex[index], timelineTrimArgs(segment, "atrim"), index,
			))
		}
		audioAndVideo := make([]string, 0, len(input.Segments))
		for index := range input.Segments {
			audioAndVideo = append(audioAndVideo, fmt.Sprintf("[v%d][a%d]", index, index))
		}
		filters = append(filters, fmt.Sprintf(
			"%sconcat=n=%d:v=1:a=1[vout][aout]",
			strings.Join(audioAndVideo, ""), len(input.Segments),
		))
	}
	outputPath := filepath.Join(workDir, "timeline.mp4")
	args = append(args,
		"-filter_complex", strings.Join(filters, ";"),
		"-map", "[vout]", "-map", "[aout]",
		"-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
		"-c:a", "aac", "-b:a", "128k",
		"-movflags", "+faststart",
		outputPath,
	)

	command := exec.CommandContext(ctx, ffmpeg, args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		return nil, fmt.Errorf("timeline concat failed: %s", detail)
	}

	output, err := os.Open(outputPath)
	if err != nil {
		return nil, err
	}
	defer output.Close()
	stat, err := output.Stat()
	if err != nil {
		return nil, err
	}
	return s.UploadFile(ctx, UploadFileInput{
		UserID:       input.UserID,
		// 产物归属当前用户：导出后前端要立即用用户身份拉取预览，系统文件（user_id=0）会导致 file.not_found
		Ownership:    FileOwnershipUser,
		Purpose:      "timeline",
		FileName:     fmt.Sprintf("timeline-%s.mp4", time.Now().Format("20060102-150405")),
		MimeType:     "video/mp4",
		DeclaredSize: stat.Size(),
		Reader:       output,
		MaxBytes:     timelineMaxOutputBytes,
	})
}

// timelineTrimArgs 生成裁剪滤镜片段；未指定有效区间时返回空串（使用整段素材）。
// 视频流使用 trim、音频流使用 atrim。
func timelineTrimArgs(segment TimelineSegment, filter string) string {
	if segment.End <= segment.Start || segment.Start < 0 {
		return ""
	}
	return fmt.Sprintf(",%s=start=%s:end=%s", filter, formatSeconds(segment.Start), formatSeconds(segment.End))
}

func formatSeconds(value float64) string {
	return strconv.FormatFloat(value, 'f', 3, 64)
}

// probeHasAudio 判断源文件是否含音频流；无音轨时拼接需要补静音轨
func probeHasAudio(ctx context.Context, ffprobe, path string) bool {
	output, err := exec.CommandContext(ctx, ffprobe,
		"-v", "error",
		"-select_streams", "a",
		"-show_entries", "stream=index",
		"-of", "csv=p=0",
		path,
	).Output()
	return err == nil && strings.TrimSpace(string(output)) != ""
}

// probeDuration 读取源文件总时长（秒），用于生成等长静音轨
func probeDuration(ctx context.Context, ffprobe, path string) float64 {
	output, err := exec.CommandContext(ctx, ffprobe,
		"-v", "error",
		"-show_entries", "format=duration",
		"-of", "csv=p=0",
		path,
	).Output()
	if err != nil {
		return 0
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(string(output)), 64)
	if err != nil || value <= 0 {
		return 0
	}
	return value
}
