package llm

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

// 上游兼容视频协议的参数范围：标准模型 4-15 秒，2.5 系模型可到 30 秒，
// 统一按最宽范围放行，具体取值由上游模型自行校验。
const (
	openAIVideoMinDurationSeconds = 4
	openAIVideoMaxDurationSeconds = 30
)

// OpenAIVideoModeFrames / OpenAIVideoModeReference 是上游参考模式的取值：
// frames 把前两张参考图映射为首帧与尾帧，reference 把参考图作为多张参考素材。
const (
	OpenAIVideoModeFrames    = "frames"
	OpenAIVideoModeReference = "reference"
)

// SanitizeOpenAIVideoOptions 将上游兼容视频协议参数收敛为实际上送的规范值。
// 本地参数键名即上游字段名，不做别名映射；Application 层复用该函数，
// 保证有效参数、计费和 adapter 请求一致。
func SanitizeOpenAIVideoOptions(options map[string]any) {
	if len(options) == 0 {
		return
	}
	if seconds, ok := openAIVideoSeconds(options); ok {
		options["seconds"] = seconds
	} else {
		delete(options, "seconds")
	}
	if resolution := openAIVideoResolutionName(options); resolution != "" {
		options["resolution_name"] = resolution
	} else {
		delete(options, "resolution_name")
	}
	if ratio := openAIVideoRatio(options); ratio != "" {
		options["ratio"] = ratio
	} else {
		delete(options, "ratio")
	}
	if size := openAIVideoSize(options); size != "" {
		options["size"] = size
	} else {
		delete(options, "size")
	}
	if mode := openAIVideoMode(options); mode != "" {
		options["mode"] = mode
	} else {
		delete(options, "mode")
	}
	for _, key := range []string{"generate_audio", "watermark"} {
		if value, ok := openAIVideoBoolOption(options, key); ok {
			options[key] = value
		} else {
			delete(options, key)
		}
	}
	for key := range options {
		switch key {
		case "seconds", "resolution_name", "ratio", "size", "mode", "generate_audio", "watermark":
		default:
			delete(options, key)
		}
	}
}

// OpenAIVideoMode 返回本次调用的参考模式；未显式指定或无法识别时按全参考处理。
func OpenAIVideoMode(options map[string]any) string {
	if mode := openAIVideoMode(options); mode != "" {
		return mode
	}
	return OpenAIVideoModeReference
}

// OpenAIVideoSizeFromTierAndRatio 由分辨率档位与画幅比例换算最终像素尺寸：
// 档位数字取短边，长边按比例折算（720p + 16:9 → 1280x720，720p + 9:16 → 720x1280）。
// 任一参数缺失或无法解析时返回空串，由调用方决定是否省略 size 字段。
func OpenAIVideoSizeFromTierAndRatio(tier string, ratio string) string {
	shortSide, ok := openAIVideoTierShortSide(tier)
	if !ok {
		return ""
	}
	ratioWidth, ratioHeight, ok := parseOpenAIVideoRatioParts(ratio)
	if !ok {
		return ""
	}
	if ratioWidth >= ratioHeight {
		longSide := int(math.Round(float64(shortSide) * float64(ratioWidth) / float64(ratioHeight)))
		return strconv.Itoa(longSide) + "x" + strconv.Itoa(shortSide)
	}
	longSide := int(math.Round(float64(shortSide) * float64(ratioHeight) / float64(ratioWidth)))
	return strconv.Itoa(shortSide) + "x" + strconv.Itoa(longSide)
}

// openAIVideoSeconds 读取时长（秒），范围 4-30；兼容上游常见的带单位字符串（如 "8s"）。
func openAIVideoSeconds(options map[string]any) (int, bool) {
	value, ok := options["seconds"]
	if !ok {
		return 0, false
	}
	seconds, parsed := openAIVideoSecondsValue(value)
	if !parsed || seconds < openAIVideoMinDurationSeconds || seconds > openAIVideoMaxDurationSeconds {
		return 0, false
	}
	return seconds, true
}

// openAIVideoSecondsValue 把整数、小数或带单位字符串（"8" / "8s"）解析为秒数。
func openAIVideoSecondsValue(value any) (int, bool) {
	if seconds, ok := IntegerOption(map[string]any{"seconds": value}, "seconds"); ok {
		return seconds, true
	}
	text, ok := value.(string)
	if !ok {
		return 0, false
	}
	normalized := strings.TrimSuffix(strings.TrimSpace(strings.ToLower(text)), "s")
	parsed, err := strconv.Atoi(strings.TrimSpace(normalized))
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// openAIVideoBoolOption 读取布尔开关；协议允许布尔或 "true" / "false" 字符串两种形态。
func openAIVideoBoolOption(options map[string]any, key string) (bool, bool) {
	value, ok := options[key]
	if !ok {
		return false, false
	}
	switch typed := value.(type) {
	case bool:
		return typed, true
	case string:
		parsed, err := strconv.ParseBool(strings.TrimSpace(typed))
		if err != nil {
			return false, false
		}
		return parsed, true
	default:
		return false, false
	}
}

// openAIVideoResolutionName 读取分辨率档位（720p / 2k 等）；自定义像素尺寸走 size 字段，不在此处混用。
func openAIVideoResolutionName(options map[string]any) string {
	value := strings.ToLower(stringOption(options, "resolution_name"))
	if videoResolutionTierPattern.MatchString(value) {
		return value
	}
	return ""
}

// openAIVideoSize 读取显式传入的像素尺寸（宽x高）；未显式传入时由适配器按档位与比例换算。
func openAIVideoSize(options map[string]any) string {
	value := strings.ToLower(stringOption(options, "size"))
	if videoPixelSizePattern.MatchString(value) {
		return value
	}
	return ""
}

// openAIVideoRatio 读取画幅比例；仅放行协议约定的固定取值。
func openAIVideoRatio(options map[string]any) string {
	value := strings.ToLower(stringOption(options, "ratio"))
	if isOpenAIVideoRatio(value) {
		return value
	}
	return ""
}

// openAIVideoMode 读取参考模式，仅接受 frames / reference；无法识别时返回空串。
func openAIVideoMode(options map[string]any) string {
	switch strings.ToLower(stringOption(options, "mode")) {
	case OpenAIVideoModeFrames:
		return OpenAIVideoModeFrames
	case OpenAIVideoModeReference:
		return OpenAIVideoModeReference
	default:
		return ""
	}
}

// openAIVideoTierShortSide 把分辨率档位解析为短边像素数（720p → 720、2k → 2048）。
func openAIVideoTierShortSide(tier string) (int, bool) {
	normalized := strings.ToLower(strings.TrimSpace(tier))
	switch {
	case strings.HasSuffix(normalized, "p"):
		value, err := strconv.Atoi(strings.TrimSuffix(normalized, "p"))
		if err != nil || value <= 0 {
			return 0, false
		}
		return value, true
	case strings.HasSuffix(normalized, "k"):
		value, err := strconv.Atoi(strings.TrimSuffix(normalized, "k"))
		if err != nil || value <= 0 {
			return 0, false
		}
		return value * 1024, true
	default:
		return 0, false
	}
}

// parseOpenAIVideoRatioParts 解析 "16:9" 形式的宽高比。
func parseOpenAIVideoRatioParts(ratio string) (int, int, bool) {
	left, right, ok := strings.Cut(strings.ToLower(strings.TrimSpace(ratio)), ":")
	if !ok {
		return 0, 0, false
	}
	ratioWidth, err := strconv.Atoi(strings.TrimSpace(left))
	if err != nil || ratioWidth <= 0 {
		return 0, 0, false
	}
	ratioHeight, err := strconv.Atoi(strings.TrimSpace(right))
	if err != nil || ratioHeight <= 0 {
		return 0, 0, false
	}
	return ratioWidth, ratioHeight, true
}

func isOpenAIVideoRatio(value string) bool {
	switch value {
	case "1:1", "16:9", "9:16", "21:9", "4:3", "3:4", "3:2", "2:3":
		return true
	default:
		return false
	}
}

// videoResolutionTierPattern 匹配分辨率档位：NNNp（420p/720p/1080p）或 Nk（2k）。
var videoResolutionTierPattern = regexp.MustCompile(`^\d{2,5}p$|^\d{1,5}k$`)

// videoPixelSizePattern 匹配像素尺寸：宽x高（1280x720）。
var videoPixelSizePattern = regexp.MustCompile(`^\d{2,5}x\d{2,5}$`)
