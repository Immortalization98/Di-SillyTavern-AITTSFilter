// Settings panel markup. Inputs with data-aitts="key" are bound to settings.

export function settingsHtml() {
    return `
<div id="aitts_settings" class="aitts-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>AI 朗读过滤</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <small class="aitts-hint">朗读前用模型去掉思考、计算、状态栏等内容，再交给原生朗读出声。只读取聊天，不修改聊天和显示。</small>
      <div id="aitts_status" class="aitts-status"></div>

      <label class="checkbox_label"><input type="checkbox" data-aitts="enabled"><span>启用</span></label>
      <label class="checkbox_label"><input type="checkbox" data-aitts="takeOverButton"><span>接管消息上的朗读按钮（关掉则恢复原生行为）</span></label>
      <label class="checkbox_label"><input type="checkbox" data-aitts="autoNarrate"><span>自动朗读新消息</span></label>
      <label class="checkbox_label"><input type="checkbox" data-aitts="prefilter"><span>新消息到达时先过滤（不朗读，之后点朗读更快；会多用模型）</span></label>

      <div class="aitts-row">
        <label for="aitts_mode">过滤方式</label>
        <select id="aitts_mode" class="text_pole" data-aitts="mode">
          <option value="llm">规则 + 模型</option>
          <option value="rules">只用规则（不调用模型）</option>
        </select>
      </div>
      <div class="aitts-row">
        <label for="aitts_source">过滤模型</label>
        <select id="aitts_source" class="text_pole" data-aitts="source">
          <option value="custom">自定义接口</option>
          <option value="profile">已有的连接配置</option>
          <option value="main">当前聊天的连接</option>
        </select>
      </div>
      <div id="aitts_custom_rows" class="aitts-custom">
        <label>接口地址（兼容 OpenAI 的 /v1 地址）</label>
        <input type="text" class="text_pole" data-aitts="customUrl" placeholder="https://…/v1" autocomplete="off">
        <label>密钥 <small id="aitts_key_state"></small></label>
        <div class="aitts-row">
          <input type="password" id="aitts_key_input" class="text_pole" placeholder="粘贴后点“保存”" autocomplete="new-password">
          <div class="menu_button" id="aitts_key_save">保存</div>
          <div class="menu_button" id="aitts_key_clear">清除</div>
        </div>
        <small class="aitts-hint">密钥保存在酒馆自带的密钥库里（和聊天的密钥分开，不改变聊天正在用的密钥），扩展设置里只记它的编号。</small>
        <label>模型名称</label>
        <div class="aitts-row">
          <input type="text" class="text_pole" data-aitts="customModel" list="aitts_model_list" placeholder="例如 deepseek-v4.1-flash" autocomplete="off">
          <div class="menu_button" id="aitts_models_fetch">获取列表</div>
        </div>
        <datalist id="aitts_model_list"></datalist>
      </div>
      <div class="aitts-row" id="aitts_profile_row">
        <label for="aitts_profile">连接配置</label>
        <select id="aitts_profile" class="text_pole"></select>
      </div>
      <div class="aitts-row">
        <label for="aitts_fail">模型出错时</label>
        <select id="aitts_fail" class="text_pole" data-aitts="onFailure">
          <option value="rules">只按规则过滤后朗读</option>
          <option value="original">朗读原文</option>
          <option value="none">不朗读</option>
        </select>
      </div>

      <details class="aitts-group" id="aitts_scheme_group">
        <summary>格式方案（锚定样例）</summary>
        <small class="aitts-hint">给几份“原文 + 正文”样例，扩展据此学会这套格式：自动找规则、AI 分析出格式说明，并用样例回测。方案可以绑定角色卡或预设，随时换绑；优先级：角色卡 &gt; 预设 &gt; 全局默认。</small>
        <div id="aitts_scheme_current" class="aitts-note aitts-note-info"></div>
        <div class="aitts-grid">
          <label>每个方案的样例上限（1–10）<input type="number" class="text_pole" min="1" max="10" data-aitts="anchorLimit"></label>
          <label>样例原文字数上限（1000–200000）<input type="number" class="text_pole" min="1000" max="200000" step="1000" data-aitts="anchorMaxChars"></label>
          <label>没有绑定时使用<select class="text_pole" id="aitts_default_scheme"></select></label>
        </div>
        <small class="aitts-hint">样例原文保存在扩展设置里（跟随账号），上限调得越高、样例越多，settings.json 就越大。</small>
        <div id="aitts_scheme_list"></div>
        <div class="menu_button" id="aitts_scheme_new">新建方案</div>
      </details>

      <details class="aitts-group">
        <summary>规则</summary>
        <label class="checkbox_label"><input type="checkbox" data-aitts="contentTagMode"><span>正文标签模式：消息里有下面这些标签时，只读标签里面的内容</span></label>
        <input type="text" class="text_pole" data-aitts="contentTags" placeholder="content, 正文">
        <label>整块跳过的标签（逗号分隔，不分大小写）</label>
        <input type="text" class="text_pole" data-aitts="skipTags">
        <label class="checkbox_label"><input type="checkbox" data-aitts="skipCode"><span>跳过代码块</span></label>
        <label class="checkbox_label"><input type="checkbox" data-aitts="skipComments"><span>跳过 HTML 注释</span></label>
        <label class="checkbox_label"><input type="checkbox" data-aitts="skipImages"><span>跳过图片</span></label>
        <label class="checkbox_label"><input type="checkbox" data-aitts="skipTables"><span>跳过 Markdown 表格行</span></label>
        <label class="checkbox_label"><input type="checkbox" data-aitts="skipDecor"><span>跳过只有符号的装饰行</span></label>
        <label>命中即跳过的正则（每行一条，可写成 /模式/i）</label>
        <textarea class="text_pole" rows="2" data-aitts="skipRegex"></textarea>
        <label>命中即保留的正则（优先于上面所有规则）</label>
        <textarea class="text_pole" rows="2" data-aitts="keepRegex"></textarea>
      </details>

      <details class="aitts-group">
        <summary>模型参数与提示词</summary>
        <div class="aitts-grid">
          <label>单段最多发送字数<input type="number" class="text_pole" min="20" max="5000" data-aitts="maxSegmentChars"></label>
          <label>最大输出<input type="number" class="text_pole" min="16" max="32000" data-aitts="maxTokens"></label>
          <label>温度（留空则不发送）<input type="number" class="text_pole" min="0" max="2" step="0.1" data-allow-empty="1" data-aitts="temperature"></label>
          <label>超时（秒）<input type="number" class="text_pole" min="5" max="300" data-aitts="timeoutSec"></label>
        </div>
        <label>提示词</label>
        <textarea class="text_pole aitts-prompt" rows="10" data-aitts="prompt"></textarea>
        <div class="menu_button" id="aitts_prompt_reset">恢复默认提示词</div>
        <small class="aitts-hint">消息原文会发给所选模型的服务商。模型只回答要跳过的片段编号，不会改写文字。</small>
      </details>

      <details class="aitts-group">
        <summary>缓存与试运行</summary>
        <div class="aitts-row">本设备缓存 <b id="aitts_cache_count">0</b> 条（只存片段编号，不存原文）
          <div class="menu_button" id="aitts_cache_clear">清空</div>
        </div>
        <div class="aitts-grid">
          <label>最多条数<input type="number" class="text_pole" min="100" max="100000" data-aitts="cacheMaxEntries"></label>
          <label>保留天数<input type="number" class="text_pole" min="1" max="3650" data-aitts="cacheMaxDays"></label>
        </div>
        <label>试运行：粘贴一段消息原文</label>
        <textarea id="aitts_try_input" class="text_pole" rows="4"></textarea>
        <div class="menu_button" id="aitts_try_run">过滤看看</div>
        <div id="aitts_try_out" class="aitts-preview aitts-try-out"></div>
      </details>
    </div>
  </div>
</div>`;
}
