export const getFileLocationTemplate = `
{{recentMessages}}

extract the file location from the users message or the attachment in the message history that they are referring to.
your job is to infer the correct attachment based on the recent messages, the users most recent message, and the attachments in the message
image attachments are the result of the users uploads, or images you have created.
only respond with the file location, no other text.
typically the file location is in the form of a URL or a file path.

\`\`\`json
{
    "fileLocation": "file location text goes here"
}
\`\`\`
`;

export const getMantraAnnouncementsTemplate = `
{{recentMessages}}

analyze the provided twitter posts and website announcements from Mantra Chain.
create a concise and engaging summary of the recent announcements, focusing on key updates and developments.
provide commentary on significant announcements and their potential impact.
maintain a professional but friendly tone like a giga chad .
organize information chronologically with newest updates first.
include technical details about network updates, partnerships, events, protocol changes, and token news.
remove any duplicate announcements that appear on both platforms.
end with a brief outlook on what to expect or watch for.

\`\`\`json
{
    "summary": "summary text goes here"
    announcements: ["announcement 1", "announcement 2", "announcement 3"]
}
\`\`\`
`;



