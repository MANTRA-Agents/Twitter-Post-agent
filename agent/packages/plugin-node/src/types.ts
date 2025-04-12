import _exp from "constants";
import { z } from "zod";

export const FileLocationResultSchema = z.object({
    fileLocation : z.string(),
})

export const AnnouncementResult = z.string();



export type FileLocationResult = z.infer<typeof FileLocationResultSchema>;


export type Announcement = z.infer<typeof AnnouncementResult>;

export function isFileLocationResult(obj: unknown): obj is FileLocationResult {
    return FileLocationResultSchema.safeParse(obj).success;
}

export function isAnnouncement(obj: unknown): obj is Announcement {
    return AnnouncementResult.safeParse(obj).success;
}


