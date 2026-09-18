package upload

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/draw"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"path"
	"strings"
	"time"

	domainconversation "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/objectstore"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/filelink"
	"go.uber.org/zap"
	_ "golang.org/x/image/bmp"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

// 缩略图变体档位：thumb 供列表/气泡，preview 供消息内大图与画布节点。
const (
	ThumbnailVariantThumb   = "thumb"
	ThumbnailVariantPreview = "preview"

	thumbnailContentType = "image/jpeg"
	thumbnailJPEGQuality = 80
)

// thumbnailPurpose 作为 FileObject.Purpose 传递给写出层，命中不可变长缓存策略。
const thumbnailPurpose = "thumbnail"

var thumbnailMaxEdge = map[string]int{
	ThumbnailVariantThumb:   400,
	ThumbnailVariantPreview: 1280,
}

var ErrThumbnailUnsupported = errors.New("thumbnail unsupported for file")

// ParseThumbnailVariant 解析变体参数，空值默认 thumb 档。
func ParseThumbnailVariant(raw string) (string, error) {
	switch strings.TrimSpace(strings.ToLower(raw)) {
	case "", ThumbnailVariantThumb:
		return ThumbnailVariantThumb, nil
	case ThumbnailVariantPreview:
		return ThumbnailVariantPreview, nil
	default:
		return "", ErrThumbnailUnsupported
	}
}

// SignedContentPath 返回生成媒体签名直连的相对路径；签名密钥未配置时返回空串。
func (s *Service) SignedContentPath(userID uint, fileID string) string {
	cfg := s.snapshot()
	return filelink.BuildSignedContentPath(cfg.JWTSecret, userID, fileID, time.Now())
}

// SignedThumbnailPath 返回缩略图变体签名直连的相对路径。
func (s *Service) SignedThumbnailPath(userID uint, fileID string, variant string) string {
	cfg := s.snapshot()
	return filelink.BuildSignedThumbnailPath(cfg.JWTSecret, userID, fileID, variant, time.Now())
}

// OpenThumbnail 打开（必要时惰性生成）指定变体。存量文件由该路径兜底补生成，
// 并发请求经 singleflight 合并，避免同图重复编码。
func (s *Service) OpenThumbnail(ctx context.Context, userID uint, fileID string, variant string) (*FileContentResult, error) {
	variant, err := ParseThumbnailVariant(variant)
	if err != nil {
		return nil, err
	}
	item, err := s.StatFileContent(ctx, userID, fileID)
	if err != nil {
		return nil, err
	}
	if !thumbnailSupportedFile(item) {
		return nil, ErrThumbnailUnsupported
	}
	store, err := s.openObjectStore(ctx)
	if err != nil {
		return nil, err
	}
	key := variantStorageKey(item.StoragePath, variant)
	reader, info, err := store.Open(ctx, key)
	if errors.Is(err, objectstore.ErrNotFound) {
		if genErr := s.ensureThumbnailVariant(ctx, store, item, variant); genErr != nil {
			return nil, genErr
		}
		reader, info, err = store.Open(ctx, key)
	}
	if err != nil {
		if errors.Is(err, objectstore.ErrNotFound) {
			return nil, s.errFileNotFound()
		}
		return nil, err
	}
	return &FileContentResult{
		File: domainconversation.FileObject{
			FileID:   item.FileID,
			FileName: path.Base(key),
			Purpose:  thumbnailPurpose,
		},
		Reader:      reader,
		ContentType: thumbnailContentType,
		SizeBytes:   info.SizeBytes,
		ModTime:     info.ModTime,
	}, nil
}

// ensureThumbnailVariant 生成并落盘单个变体；singleflight 按 file+variant 合并并发。
func (s *Service) ensureThumbnailVariant(ctx context.Context, store objectstore.Store, item *domainconversation.FileObject, variant string) error {
	_, err, _ := s.thumbFlight.Do(item.FileID+":"+variant, func() (any, error) {
		original, _, err := store.Open(ctx, item.StoragePath)
		if err != nil {
			if errors.Is(err, objectstore.ErrNotFound) {
				return nil, s.errFileNotFound()
			}
			return nil, err
		}
		defer original.Close() //nolint:errcheck
		jpegBytes, err := renderThumbnailVariant(original, thumbnailMaxEdge[variant])
		if err != nil {
			return nil, err
		}
		if _, err := store.Put(ctx, variantStorageKey(item.StoragePath, variant), bytes.NewReader(jpegBytes), objectstore.PutOptions{
			SizeBytes:   int64(len(jpegBytes)),
			ContentType: thumbnailContentType,
		}); err != nil {
			return nil, err
		}
		return nil, nil
	})
	return err
}

// prewarmThumbnailVariants 上传成功后后台预热两档变体；失败静默，由惰性生成兜底。
func (s *Service) prewarmThumbnailVariants(item domainconversation.FileObject) {
	if !thumbnailSupportedFile(&item) {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		store, err := s.openObjectStore(ctx)
		if err != nil {
			return
		}
		for _, variant := range []string{ThumbnailVariantThumb, ThumbnailVariantPreview} {
			// 已存在时 store.Put 覆盖同样内容（原文件不可变，变体幂等），代价只是一次重编码；
			// 为省 CPU 先探测存在性。
			if _, _, err := store.Open(ctx, variantStorageKey(item.StoragePath, variant)); err == nil {
				continue
			}
			if err := s.ensureThumbnailVariant(ctx, store, &item, variant); err != nil && s.logger != nil {
				s.logger.Warn("thumbnail_prewarm_failed",
					zap.String("file_id", item.FileID),
					zap.String("variant", variant),
					zap.Error(err),
				)
			}
		}
	}()
}

// deleteThumbnailVariants 删除文件时同步清理两档变体；失败仅记录日志。
func (s *Service) deleteThumbnailVariants(ctx context.Context, store objectstore.Store, storagePath string) {
	for _, variant := range []string{ThumbnailVariantThumb, ThumbnailVariantPreview} {
		if err := store.Delete(ctx, variantStorageKey(storagePath, variant)); err != nil && s.logger != nil {
			s.logger.Warn("thumbnail_variant_delete_failed",
				zap.String("storage_path", storagePath),
				zap.String("variant", variant),
				zap.Error(err),
			)
		}
	}
}

// thumbnailSupportedFile 仅位图类图片支持变体；SVG 服务端按 text/plain 改写，视频依赖 Range + 海报图。
func thumbnailSupportedFile(item *domainconversation.FileObject) bool {
	if item == nil || item.FileCategory != fileCategoryImage {
		return false
	}
	combined := strings.ToLower(strings.TrimSpace(item.MimeType)) + " " + strings.ToLower(strings.TrimSpace(item.DetectedMIME))
	if strings.Contains(combined, "svg") {
		return false
	}
	return true
}

// variantStorageKey 从原件存储路径派生变体键：与原件同目录，后缀替换为 {variant}.jpg。
func variantStorageKey(storagePath string, variant string) string {
	trimmed := strings.TrimSuffix(storagePath, path.Ext(storagePath))
	return trimmed + "." + variant + ".jpg"
}

// renderThumbnailVariant 解码原图、按长边缩放、合成白色背景后编码 JPEG。
// 无法解码的图片（损坏或未注册格式）返回 ErrThumbnailUnsupported，由调用方按 404 处理。
func renderThumbnailVariant(reader io.Reader, maxEdge int) ([]byte, error) {
	src, _, err := image.Decode(reader)
	if err != nil {
		return nil, ErrThumbnailUnsupported
	}
	bounds := src.Bounds()
	srcW := bounds.Dx()
	srcH := bounds.Dy()
	dstW, dstH := srcW, srcH
	if maxEdge > 0 && (srcW > maxEdge || srcH > maxEdge) {
		if srcW >= srcH {
			dstW = maxEdge
			dstH = max(1, srcH*maxEdge/srcW)
		} else {
			dstH = maxEdge
			dstW = max(1, srcW*maxEdge/srcH)
		}
	}
	// 先铺白底再绘制，消除 PNG/WebP/GIF 透明通道在 JPEG 中的黑底问题。
	dst := image.NewRGBA(image.Rect(0, 0, dstW, dstH))
	draw.Draw(dst, dst.Bounds(), image.NewUniform(image.White), image.Point{}, draw.Src)
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), src, bounds, xdraw.Over, nil)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: thumbnailJPEGQuality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
