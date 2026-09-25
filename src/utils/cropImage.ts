// src/utils/cropImage.ts — react-easy-crop 标准裁剪工具（输出 JPEG Blob）
export interface CropArea {
    x: number;
    y: number;
    width: number;
    height: number;
}

async function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.addEventListener('load', () => resolve(image));
        image.addEventListener('error', (e) => reject(e));
    image.crossOrigin = 'anonymous';
        image.src = src;
    });
}

function getCroppedCanvas(image: HTMLImageElement, crop: CropArea, maxWidth = 512): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, maxWidth / crop.width);
    canvas.width = Math.round(crop.width * scale);
    canvas.height = Math.round(crop.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2d context');

    const pixelRatio = 1;
    canvas.width = Math.round(crop.width * scale * pixelRatio);
    canvas.height = Math.round(crop.height * scale * pixelRatio);
    ctx.imageSmoothingQuality = 'high';

    ctx.drawImage(
        image,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        canvas.width,
        canvas.height,
    );
    return canvas;
}

/** 裁剪并压缩为 JPEG Blob；失败返回 null（由调用方兜底）。 */
export default async function getCroppedImg(
    imageSrc: string,
    croppedAreaPixels: CropArea | null | undefined,
): Promise<Blob | null> {
    if (!imageSrc || !croppedAreaPixels) return null;
    try {
        const image = await loadImage(imageSrc);
        const canvas = getCroppedCanvas(image, croppedAreaPixels);
        return await new Promise<Blob | null>((resolve) => {
            canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.9);
        });
    } catch (e) {
        console.error('cropImage failed', e);
        return null;
    }
}
