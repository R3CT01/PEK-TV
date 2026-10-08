class ThemePanel extends HesperComponent {
    render() {
        const { engine, onClose } = this.props;
        const { createElement, ui } = engine;
        const presetNames = engine.theme.listPresets();
        const currentTokens = engine.theme.getAll();

        const presetCards = presetNames.map(name => {
            const tokens = engine.theme.presets[name];
            return createElement('div', {
                className: `preset-card focusable ${engine.theme.get('bg') === tokens.bg ? 'active-preset' : ''}`,
                onClick: () => {
                    engine.theme.applyPreset(name);
                    if (this.props.onRefresh) this.props.onRefresh();
                }
            },
                createElement('div', {
                    className: 'preset-preview-swatch',
                    style: { background: `linear-gradient(135deg, ${tokens.bg} 0%, ${tokens.surface} 50%, ${tokens.accent} 100%)` }
                }),
                createElement('div', { className: 'preset-name' }, name)
            );
        });

        const colorPickers = [
            { key: 'accent', label: 'Accent Color' },
            { key: 'bg', label: 'Background' },
            { key: 'surface', label: 'Surface' },
            { key: 'text', label: 'Text Color' }
        ].map(({ key, label }) => {
            return createElement('div', { className: 'theme-row' },
                createElement('label', {}, label),
                createElement('input', {
                    type: 'color',
                    value: currentTokens[key] || '#000000',
                    onInput: (e) => {
                        // No re-render here: rebuilding the <input> mid-drag would close the native color picker.
                        engine.theme.set(key, e.target.value);
                    }
                })
            );
        });

        const content = createElement('div', {},
            createElement('p', { className: 'sub' }, 'Select a visual theme or customize token colors:'),
            createElement('div', { className: 'preset-container' }, ...presetCards),
            createElement('div', { className: 'color-grid' }, ...colorPickers)
        );

        return ui.modal('Theme Settings', content, onClose);
    }
}
