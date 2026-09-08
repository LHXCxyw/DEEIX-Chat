package llm

import (
	"regexp"
	"strings"
)

// SanitizeOpenAIVideoOptions 将 Sora 兼容视频协议参数收敛为实际上送的规范值。
// 支持 duration/seconds 与 resolution/size 别名归一；Application 层复用该函数，
// 保证有效参数、计费和 adapter 请求一致。
func SanitizeOpenAIVideoOptions(options map[string]any) {
	if len(options) == 0 {
		return
	}
	duration, durationOK := openAIVideoDurationOption(options)
	if durationOK {
		options["duration"] = duration
	} else {
		delete(options, "duration")
	}
	delete(options, "seconds")
	resolution := openAIVideoResolutionOption(options)
	if resolution != "" {
		options["resolution"] = resolution
	} else {
		delete(options, "resolution")
	}
	delete(options, "size")
	aspectRatio := strings.ToLower(stringOption(options, "aspect_ratio"))
	if isOpenAIVideoAspectRatio(aspectRatio) {
		options["aspect_ratio"] = aspectRatio
	} else {
		delete(options, "aspect_ratio")
	}
	for key := range options {
		switch key {
		case "duration", "resolution", "aspect_ratio":
		default:
			delete(options, key)
		}
	}
}

// openAIVideoDurationOption 读取 duration 或其字符串别名 seconds，范围 1-15 秒。
func openAIVideoDurationOption(options map[string]any) (int, bool) {
	if duration, ok := IntegerOption(options, "duration"); ok && duration >= 1 && duration <= 15 {
		return duration, true
	}
	if seconds, ok := IntegerOption(options, "seconds"); ok && seconds >= 1 && seconds <= 15 {
		return seconds, true
	}
	return 0, false
}

// openAIVideoResolutionOption 读取 resolution 或其尺寸别名 size（如 1280x720），
// 档位值（480p/720p/1080p）或自定义分辨率（420p/2k/2560x1440 等）均有效；无法识别时返回空串。
func openAIVideoResolutionOption(options map[string]any) string {
	if resolution := strings.ToLower(stringOption(options, "resolution")); isOpenAIVideoResolution(resolution) {
		return resolution
	}
	return sizeAliasToResolution(strings.ToLower(stringOption(options, "size")))
}

func sizeAliasToResolution(size string) string {
	switch strings.TrimSpace(size) {
	case "854x480", "480p":
		return "480p"
	case "1280x720", "720p":
		return "720p"
	case "1920x1080", "1080p":
		return "1080p"
	default:
		return ""
	}
}

func isOpenAIVideoAspectRatio(value string) bool {
	switch value {
	case "1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3":
		return true
	default:
		return false
	}
}

// videoResolutionPattern 匹配自定义视频分辨率：NNNp（420p/768p/1080p）、Nk（2k/4k）或 宽x高（2560x1440）
var videoResolutionPattern = regexp.MustCompile(`^\d{2,5}p$|^\d{1,5}k$|^\d{2,5}x\d{2,5}$`)

// isOpenAIVideoResolution 除固定档位外放行常见自定义分辨率格式，由上游模型自行校验取值
func isOpenAIVideoResolution(value string) bool {
	return videoResolutionPattern.MatchString(value)
}
