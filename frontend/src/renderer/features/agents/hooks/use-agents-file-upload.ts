// File upload hook for desktop app with base64 conversion for Claude API
import { useState, useCallback, useEffect, useRef } from "react"
import { toast } from "sonner"
import { createLocalId } from "../../../../shared/id"

export interface UploadedImage {
  id: string
  filename: string
  url: string // blob URL for preview
  base64Data?: string // base64 encoded data for API
  isLoading: boolean
  mediaType?: string // MIME type e.g. "image/png", "image/jpeg"
}

export interface UploadedFile {
  id: string
  filename: string
  url: string
  base64Data?: string // base64 encoded data for API
  isLoading: boolean
  size?: number
  type?: string
  isFolder?: boolean // Whether this is a folder (shows folder icon)
  folderFiles?: string[] // List of file paths inside the folder (for display)
}

/**
 * Convert a Blob (or File) to base64 data.
 * File extends Blob, so this works for both.
 */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      // Remove the data:image/xxx;base64, prefix
      const base64 = result.split(",")[1]
      resolve(base64 || "")
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export function useAgentsFileUpload() {
  const [images, setImages] = useState<UploadedImage[]>([])
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [isUploading, setIsUploading] = useState(false)

  // Track blob URLs to prevent memory leaks
  const blobUrlsRef = useRef<Set<string>>(new Set())

  const handleAddAttachments = useCallback(async (inputFiles: File[]) => {
    setIsUploading(true)

    const imageFiles = inputFiles.filter((f) => f.type.startsWith("image/"))
    const otherFiles = inputFiles.filter((f) => !f.type.startsWith("image/"))

    // Process images with base64 conversion
    const newImages: UploadedImage[] = await Promise.all(
      imageFiles.map(async (file) => {
        const id = createLocalId("local-image")
        const filename = file.name || `screenshot-${Date.now()}.png`
        const mediaType = file.type || "image/png"
        const url = URL.createObjectURL(file)
        blobUrlsRef.current.add(url)

        // Convert to base64 for API
        let base64Data: string | undefined
        try {
          base64Data = await blobToBase64(file)
        } catch (err) {
          console.error("[useAgentsFileUpload] Failed to convert image to base64:", err)
          toast.error(`Failed to process image "${filename}"`)
        }

        return {
          id,
          filename,
          url,
          base64Data,
          isLoading: false,
          mediaType,
        }
      })
    )

    const newFiles: UploadedFile[] = await Promise.all(
      otherFiles.map(async (file) => {
        let base64Data: string | undefined
        try {
          base64Data = await blobToBase64(file)
        } catch (err) {
          console.error("[useAgentsFileUpload] Failed to convert file to base64:", err)
          toast.error(`Failed to process file "${file.name}"`)
        }
        const url = URL.createObjectURL(file)
        blobUrlsRef.current.add(url)
        return {
          id: createLocalId("local-file"),
          filename: file.name,
          url,
          base64Data,
          isLoading: false,
          size: file.size,
          type: file.type,
        }
      })
    )

    setImages((prev) => [...prev, ...newImages])
    setFiles((prev) => [...prev, ...newFiles])
    setIsUploading(false)
  }, [])

  const removeImage = useCallback((id: string) => {
    setImages((prev) => {
      const img = prev.find((img) => img.id === id)
      if (img?.url) {
        URL.revokeObjectURL(img.url)
        blobUrlsRef.current.delete(img.url)
      }
      return prev.filter((img) => img.id !== id)
    })
  }, [])

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => {
      const file = prev.find((f) => f.id === id)
      if (file?.url) {
        URL.revokeObjectURL(file.url)
        blobUrlsRef.current.delete(file.url)
      }
      return prev.filter((f) => f.id !== id)
    })
  }, [])

  const clearImages = useCallback(() => {
    setImages((prev) => {
      prev.forEach((img) => {
        if (img.url) {
          URL.revokeObjectURL(img.url)
          blobUrlsRef.current.delete(img.url)
        }
      })
      return []
    })
  }, [])

  const clearFiles = useCallback(() => {
    setFiles((prev) => {
      prev.forEach((file) => {
        if (file.url) {
          URL.revokeObjectURL(file.url)
          blobUrlsRef.current.delete(file.url)
        }
      })
      return []
    })
  }, [])

  // Handle folder upload - creates a virtual folder attachment
  const handleAddFolder = useCallback((folderName: string, folderFilePaths: string[]) => {
    const folderFile: UploadedFile = {
      id: createLocalId("local-folder"),
      filename: folderName,
      url: "", // No blob URL for folders
      isLoading: false,
      size: 0,
      type: "folder",
      isFolder: true,
      folderFiles: folderFilePaths,
    }
    setFiles((prev) => [...prev, folderFile])
  }, [])


  const clearAll = useCallback(() => {
    setImages((prev) => {
      prev.forEach((img) => {
        if (img.url) {
          URL.revokeObjectURL(img.url)
          blobUrlsRef.current.delete(img.url)
        }
      })
      return []
    })
    setFiles((prev) => {
      prev.forEach((file) => {
        if (file.url) {
          URL.revokeObjectURL(file.url)
          blobUrlsRef.current.delete(file.url)
        }
      })
      return []
    })
  }, [])

  // Cleanup all blob URLs when component unmounts
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((url) => {
        URL.revokeObjectURL(url)
      })
      blobUrlsRef.current.clear()
    }
  }, [])

  // Direct state setters for restoring from draft
  const setImagesFromDraft = useCallback((draftImages: UploadedImage[]) => {
    // Track blob URLs from drafts
    draftImages.forEach((img) => {
      if (img.url) {
        blobUrlsRef.current.add(img.url)
      }
    })
    setImages(draftImages)
  }, [])

  const setFilesFromDraft = useCallback((draftFiles: UploadedFile[]) => {
    // Track blob URLs from drafts
    draftFiles.forEach((file) => {
      if (file.url) {
        blobUrlsRef.current.add(file.url)
      }
    })
    setFiles(draftFiles)
  }, [])

  return {
    images,
    files,
    handleAddAttachments,
    handleAddFolder,
    removeImage,
    removeFile,
    clearImages,
    clearFiles,
    clearAll,
    isUploading,
    setImagesFromDraft,
    setFilesFromDraft,
  }
}
