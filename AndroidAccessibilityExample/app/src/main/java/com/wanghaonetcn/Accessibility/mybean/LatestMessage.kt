package com.wanghaonetcn.Accessibility.mybean

class LatestMessage {
    @JvmField var url: String? = null
    @JvmField var assets_url: String? = null
    @JvmField var upload_url: String? = null
    @JvmField var html_url: String? = null
    @JvmField var id: String? = null
    @JvmField var node_id: String? = null
    @JvmField var tag_name: String? = null
    @JvmField var target_commitish: String? = null
    @JvmField var name: String? = null
    @JvmField var created_at: String? = null
    @JvmField var published_at: String? = null
    @JvmField var tarball_url: String? = null
    @JvmField var zipball_url: String? = null
    @JvmField var body: String? = null
    @JvmField var draft: Boolean = false
    @JvmField var prerelease: Boolean = false
    @JvmField var author: Author? = null
    @JvmField var assets: List<Asset>? = null

    class Asset {
        @JvmField var url: String? = null
        @JvmField var id: String? = null
        @JvmField var node_id: String? = null
        @JvmField var name: String? = null
        @JvmField var label: String? = null
        @JvmField var content_type: String? = null
        @JvmField var state: String? = null
        @JvmField var size: String? = null
        @JvmField var download_count: String? = null
        @JvmField var created_at: String? = null
        @JvmField var updated_at: String? = null
        @JvmField var browser_download_url: String? = null
        @JvmField var uploader: Uploader? = null
    }

    class Author {
        @JvmField var login: String? = null
        @JvmField var id: String? = null
        @JvmField var node_id: String? = null
        @JvmField var avatar_url: String? = null
        @JvmField var gravatar_id: String? = null
        @JvmField var url: String? = null
        @JvmField var html_url: String? = null
        @JvmField var followers_url: String? = null
        @JvmField var following_url: String? = null
        @JvmField var gists_url: String? = null
        @JvmField var starred_url: String? = null
        @JvmField var subscriptions_url: String? = null
        @JvmField var organizations_url: String? = null
        @JvmField var repos_url: String? = null
        @JvmField var events_url: String? = null
        @JvmField var received_events_url: String? = null
        @JvmField var type: String? = null
        @JvmField var site_admin: String? = null
    }

    class Uploader {
        @JvmField var login: String? = null
        @JvmField var id: String? = null
        @JvmField var node_id: String? = null
        @JvmField var avatar_url: String? = null
        @JvmField var gravatar_id: String? = null
        @JvmField var url: String? = null
        @JvmField var html_url: String? = null
        @JvmField var followers_url: String? = null
        @JvmField var following_url: String? = null
        @JvmField var gists_url: String? = null
        @JvmField var starred_url: String? = null
        @JvmField var subscriptions_url: String? = null
        @JvmField var organizations_url: String? = null
        @JvmField var repos_url: String? = null
        @JvmField var events_url: String? = null
        @JvmField var received_events_url: String? = null
        @JvmField var type: String? = null
        @JvmField var site_admin: String? = null
    }
}
