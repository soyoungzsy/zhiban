# 维护与恢复 / Maintenance and recovery

本文件说明更新、故障与恢复办法，不能单独作为发行验收证明。源码可公开读取不等于安装、功能和发行物已验收。

## 版本与后续 AI 修改

使用现有版本源，不在提报时静默改变已发布 tag 或替换旧包。兼容修复增 patch，新功能增 minor，破坏性变化说明迁移并采用相应版本。合并前决定实际版本并同步更新 CHANGELOG、tag、Release 与下载引用。现有发行记录以 GitHub Releases 为准；无 Release 时不能凭 README 的版本号宣称已发行。

AI 修改使用独立分支和 PR，写明问题、最终行为、实际检查/未检查项、兼容性、恢复办法。不覆盖用户未提交修改。遵守分支保护，不擅自重写历史。

## 本项目恢复办法

在设置导出包含档案与照片的备份，核验可恢复后再更新。同一浏览器源保存数据；更换协议/域名/端口会改变存储源。代码/Service Worker 降级不保证恢复数据格式，先备份再操作。

## 故障与隐私

提供当前版本、环境、复现、预期与实际结果及脱敏日志；公开 Issues 不含个人数据、工作材料、凭据。安全问题走已配置的私密渠道；无私密渠道时不要把秘密贴进 Issues，也不虚构支持邮箱或响应承诺。模型与外部服务的费用、处理和留存按各自规则执行。

## 发布后自检

每次真实发布后，从公开入口以首次接触者视角检查中文/英文介绍、目标用户、准备条件、安装/复制入口、成功结果、费用/权限、限制和故障恢复。记录仍有的疑问、修订与复查。未解决核心使用问题不能标为已验收；AI 视角自检不冒充真人反馈。

## English essentials

This maintenance guide is not a release certificate. Use branches and reviewable PRs; record actual checks and limitations. Preserve existing tags/assets. Set the next version at merge and keep release references consistent. Back up source, local configuration and user data before upgrading; reverting code does not undo data migrations or external actions. Report sanitized reproductions through Issues, never work material or credentials. After each real release, review its public entry point as a newcomer in both languages, resolve blocking questions and recheck before acceptance. No independent-user validation is implied.

## 5.1.0 访问与额度迁移

更新前导出档案备份、备份旧程序和服务器环境配置；不要把这些私人备份上传GitHub。真实服务部署须新增至少32字符的随机访问口令，由使用者在设置页输入。默认仅本机监听；远程须HTTPS、隔离后端端口并设置服务商硬性预算。把USAGE_DIR放在持久卷；多个实例共享同一目录。额度记录损坏或锁遗留会拒绝调用，先停止所有实例、核对服务商用量，再由维护者处理；不要为绕过限制直接删除计数。回退旧代码会恢复已知的公开口令问题，故付费公网部署不得回退到旧版，应停用付费功能并保留数据。
