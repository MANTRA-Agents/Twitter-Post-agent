import _exp from "constants";
import { z } from "zod";

export const FileLocationResultSchema = z.object({
    fileLocation : z.string(),
})

export const AnnouncementResultSchema = z.object({
    summary : z.string(),
    announcements : z.array(z.string()),
})



export type FileLocationResult = z.infer<typeof FileLocationResultSchema>;


export type AnnouncementResult = z.infer<typeof AnnouncementResultSchema>;

export function isFileLocationResult(obj: unknown): obj is FileLocationResult {
    return FileLocationResultSchema.safeParse(obj).success;
}

export function isAnnouncementResult(obj: unknown): obj is AnnouncementResult {
    return AnnouncementResultSchema.safeParse(obj).success;
}
